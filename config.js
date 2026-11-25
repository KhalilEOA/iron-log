// FlashTickets configuration
// The token is NEVER written here: set it on the VM with
//   setx TICKETS_BOT_TOKEN "your-token"
module.exports = {
  BOT_TOKEN: process.env.TICKETS_BOT_TOKEN,
  // Your Discord user id: can use every command on every server
  OWNER_ID: process.env.TICKETS_OWNER_ID || "1436318533435920404",
  // Bot embed color
  COLOR: 0x3ba55d, // green, like Ticket Tool
};
