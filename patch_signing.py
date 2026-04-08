#!/usr/bin/env python3
"""Patch project.pbxproj with team ID from provisioning profile."""
import subprocess, glob, re, sys, plistlib, os

# Find provisioning profile
profiles = glob.glob(os.path.expanduser(
    "~/Library/MobileDevice/Provisioning Profiles/*.mobileprovision"))
if not profiles:
    print("ERROR: No provisioning profiles found")
    sys.exit(1)

profile = profiles[0]
print(f"Using profile: {profile}")

# Extract plist from profile
result = subprocess.run(
    ["security", "cms", "-D", "-i", profile],
    capture_output=True)
plist_data = plistlib.loads(result.stdout)
team_id = plist_data.get("TeamIdentifier", [""])[0]
profile_name = plist_data.get("Name", "")
print(f"Team ID: {team_id}")
print(f"Profile name: {profile_name}")

if not team_id:
    print("ERROR: Could not extract team ID")
    sys.exit(1)

# Patch project.pbxproj
pbxproj = "ios/App/App.xcodeproj/project.pbxproj"
with open(pbxproj, "r") as f:
    content = f.read()

# Replace empty/missing DEVELOPMENT_TEAM
content = re.sub(r'DEVELOPMENT_TEAM = "";', f'DEVELOPMENT_TEAM = {team_id};', content)
content = re.sub(r'DEVELOPMENT_TEAM = ;', f'DEVELOPMENT_TEAM = {team_id};', content)

# If still no team, add it after every CODE_SIGN_STYLE occurrence
if team_id not in content:
    content = re.sub(
        r'(CODE_SIGN_STYLE = [^;]+;)',
        r'\1\n\t\t\t\tDEVELOPMENT_TEAM = ' + team_id + ';',
        content)

with open(pbxproj, "w") as f:
    f.write(content)

# Verify
matches = re.findall(r'DEVELOPMENT_TEAM = ([^;]+);', content)
print(f"DEVELOPMENT_TEAM values set: {set(matches)}")
print("Done patching project.pbxproj")
