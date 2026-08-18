// Run once: node generate-vapid-keys.js
// Prints a VAPID key pair. Put the public key in the Brainkind app settings
// and both keys in your server's environment variables.
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\nVAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\nSave these somewhere safe — you will need both when deploying,');
console.log('and the public key goes into the Brainkind app under Settings > Server URL.\n');
