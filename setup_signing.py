#!/usr/bin/env python3
"""
STEP 1 ONLY: Delete all stale Distribution certs and App Store profiles via REST API.
Codemagic CLI tools (fetch-signing-files, keychain add-certificates) handle creation.
"""
import os, sys, json, time
from pathlib import Path

try:
    import jwt as pyjwt
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "PyJWT", "cryptography", "-q"])
    import jwt as pyjwt

import urllib.request, urllib.error

KEY_ID    = os.environ["APP_STORE_CONNECT_KEY_IDENTIFIER"]
ISSUER_ID = os.environ["APP_STORE_CONNECT_ISSUER_ID"]
KEY_PEM   = os.environ["APP_STORE_CONNECT_PRIVATE_KEY"]
BUNDLE_ID = os.environ.get("BUNDLE_ID", "com.bluesapps.supremetransfer")

def make_token():
    now = int(time.time())
    payload = {"iss": ISSUER_ID, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"}
    return pyjwt.encode(payload, KEY_PEM, algorithm="ES256", headers={"kid": KEY_ID})

def api(method, path, body=None):
    token = make_token()
    url = f"https://api.appstoreconnect.apple.com/v1{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read()) if r.length != 0 else {}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        print(f"  HTTP {e.code}: {body_text[:300]}")
        return {"error": e.code, "body": body_text}

# 1. Delete all Distribution certs
print("=== Deleting stale Distribution certs ===")
for cert_type in ["DISTRIBUTION", "IOS_DISTRIBUTION"]:
    res = api("GET", f"/certificates?filter[certificateType]={cert_type}&limit=50")
    certs = res.get("data", [])
    print(f"  Found {len(certs)} certs of type {cert_type}")
    for c in certs:
        cid = c["id"]
        print(f"  Deleting cert {cid}...")
        api("DELETE", f"/certificates/{cid}")
        print(f"  Done")

print("  Waiting 3s for Apple to process...")
time.sleep(3)

# 2. Delete stale App Store provisioning profiles
print("\n=== Deleting stale App Store profiles ===")
res = api("GET", f"/bundleIds?filter[identifier]={BUNDLE_ID}&filter[platform]=IOS")
bundle_ids = [b for b in res.get("data", []) if b["attributes"]["identifier"] == BUNDLE_ID]
if bundle_ids:
    bundle_resource_id = bundle_ids[0]["id"]
    prof_res = api("GET", f"/profiles?filter[bundleId]={bundle_resource_id}&filter[profileType]=IOS_APP_STORE&limit=50")
    for p in prof_res.get("data", []):
        pid = p["id"]
        print(f"  Deleting profile {pid}...")
        api("DELETE", f"/profiles/{pid}")
        print(f"  Done")
else:
    print(f"  Bundle ID {BUNDLE_ID} not found — skipping profile cleanup")

print("\n=== Generating RSA private key for CERTIFICATE_PRIVATE_KEY ===")
import subprocess
subprocess.run(["openssl", "genrsa", "-out", "/tmp/dist_signing.key", "2048"], check=True)
with open("/tmp/dist_signing.key") as f:
    key_pem = f.read()
print("  Key written to /tmp/dist_signing.key")
print("\n=== Cleanup complete — shell will export CERTIFICATE_PRIVATE_KEY and run fetch-signing-files ===")
