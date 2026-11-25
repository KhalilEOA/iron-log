# FlashTickets — self-hosted ticket bot (free Ticket Tool alternative)

## 1. Create the bot (Discord Developer Portal)
1. https://discord.com/developers/applications → **New Application** → name it (e.g. FlashTickets).
2. **Bot** tab → **Reset Token** → copy the token (never paste it in a file or a chat).
3. Same tab → **Privileged Gateway Intents** → turn ON **Server Members Intent** and **Message Content Intent** (needed for transcripts) → Save.
4. **OAuth2 → URL Generator** → scopes: `bot` + `applications.commands`
   Bot permissions: Manage Channels, Manage Roles, View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Manage Messages.
   Open the generated URL and invite the bot to your server.
5. In Server Settings → Roles, drag the bot's role **above** your staff roles.

## 2. Install on the VM (same one as FlashACO)
```
cd C:\Users\Administrator\Desktop
(copy the FlashTickets folder here)
cd FlashTickets
npm install
setx TICKETS_BOT_TOKEN "paste-the-token-here"
```
Close and reopen the terminal (setx only applies to new terminals), then:
```
pm2 start index.js --name flashtickets
pm2 save
```
Update later: replace index.js → `pm2 restart flashtickets --update-env`

## 3. Setup in Discord (admins = Manage Server permission)
```
/ticket_logs channel:#ticket-logs
/category_add name:Support staff_role:@Staff parent:<Discord category>
/panel channel:#support title:STAFF HELP description:Welcome to the Support Channel!\n\nThank you for being part of Flash ACO.
```
One category → one green "📩 Create ticket" button. Several → one button per category (6+ → dropdown menu).

## Commands
| Command | Who | What |
|---|---|---|
| /ticket_logs | admin | Log + transcript channel |
| /ticket_settings | admin | auto_close_hours, max_open, ratings |
| /category_add · _edit · _remove · _list | admin | Panel categories (staff role, Discord category, question, emoji, button text) |
| /panel | admin | Post / repost the panel (title, description, color, image) |
| /claim · /unclaim | staff | Take charge of a ticket |
| /add @user · /remove @user | staff | Give / remove access |
| /rename | staff | Rename (Discord: 2 per 10 min) |
| /close [reason] | staff or ticket owner | Close |
| /transcript | staff | HTML transcript |
| /ticket_stats | staff | Counts + average rating |

On close: the member loses access, staff get Transcript / Open / Delete buttons, the HTML transcript goes to the log channel and to the member by DM with a 1–5★ rating.
Data is saved in the `data/` folder (created automatically).
