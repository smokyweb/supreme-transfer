// INSTANT PAYOUT TEST COMMANDS
// Run these in browser console after adding the endpoints

// 1. CHECK IF INSTANT PAYOUT IS AVAILABLE
fetch('/api/stripe/instant-payout-available', {
  headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
}).then(r => r.json()).then(data => {
  console.log('=== INSTANT PAYOUT AVAILABILITY ===');
  console.log('Available:', data.available);
  console.log('Amount:', data.formatted.instant);
  console.log('Fee (1.5%):', data.formatted.fee);
  console.log('You receive:', data.formatted.youReceive);
  
  if (data.available) {
    console.log('\n✅ You can get an instant payout now!');
    console.log('Run the command below to process it.');
  } else {
    console.log('\n⏳ Not available yet. Funds need to process first.');
  }
});

// 2. PROCESS INSTANT PAYOUT (Run this after checking availability)
function doInstantPayout() {
  if (!confirm('Process instant payout? You will be charged a 1.5% fee.')) {
    return;
  }
  
  fetch('/api/stripe/instant-payout', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + localStorage.getItem('token'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({}) // Empty = payout full amount
  }).then(r => r.json()).then(data => {
    if (data.success) {
      console.log('✅ SUCCESS!', data.message);
      console.log('Payout ID:', data.payout.id);
      console.log('You receive:', data.formatted.youReceive);
      console.log('Fee charged:', data.formatted.fee);
      alert(`Success! ${data.message}`);
    } else {
      console.error('❌ Failed:', data.error);
      alert(`Error: ${data.error}`);
    }
  });
}

// To process payout, run:
// doInstantPayout()

console.log('Commands loaded. Check availability first, then run doInstantPayout() if available.');
