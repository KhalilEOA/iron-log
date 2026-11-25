// ─────────────────────────────────────────────────────────────
// FlashTickets — self-hosted ticket bot (Ticket Tool alternative)
// Panel + categories, claim, close / reopen / delete, HTML transcripts,
// add / remove / rename, auto-close on inactivity, 1–5★ ratings.
// ─────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
  ChannelType, SlashCommandBuilder, AttachmentBuilder,
} = require("discord.js");
const config = require("./config");

// ─────────────────────────────────────────────
// Storage (JSON files in ./data)
// ─────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const GUILDS_FILE = path.join(DATA_DIR, "guilds.json");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveJSON(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// guilds[guildId] = { counter, logChannelId, autoCloseHours, maxOpen, ratings, categories:[...], panel:{...} }
const guilds = loadJSON(GUILDS_FILE, {});
// tickets[channelId] = { guildId, number, ownerId, categoryId, openedAt, claimedBy, status, lastActivity, ... }
const tickets = loadJSON(TICKETS_FILE, {});
const saveGuilds = () => saveJSON(GUILDS_FILE, guilds);
const saveTickets = () => saveJSON(TICKETS_FILE, tickets);

function G(guildId) {
  if (!guilds[guildId]) {
    guilds[guildId] = { counter: 0, logChannelId: null, autoCloseHours: 0, maxOpen: 1, ratings: true, categories: [], panel: null };
    saveGuilds();
  }
  return guilds[guildId];
}
const catOf = (g, id) => g.categories.find(c => c.id === id);
const catByName = (g, name) => g.categories.find(c => c.name.toLowerCase() === String(name || "").trim().toLowerCase());
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad = n => String(n).padStart(4, "0");
const slug = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

// ─────────────────────────────────────────────
// Permissions
// ─────────────────────────────────────────────
function isAdmin(member, userId) {
  if (userId === config.OWNER_ID) return true;
  return !!member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);
}
// Staff of a given category (or of any category when cat is null)
function isStaff(member, userId, g, cat) {
  if (isAdmin(member, userId)) return true;
  const roles = member?.roles?.cache;
  if (!roles) return false;
  const ids = cat ? (cat.staffRoleIds || []) : g.categories.flatMap(c => c.staffRoleIds || []);
  return ids.some(id => roles.has(id));
}

// ─────────────────────────────────────────────
// Discord client
// ─────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

// ─────────────────────────────────────────────
// Slash commands
// ─────────────────────────────────────────────
const ADMIN = PermissionFlagsBits.ManageGuild;
const commands = [
  new SlashCommandBuilder().setName("ticket_logs").setDescription("[ADMIN] Channel for ticket logs and transcripts")
    .setDefaultMemberPermissions(ADMIN)
    .addChannelOption(o => o.setName("channel").setDescription("Log channel").addChannelTypes(ChannelType.GuildText).setRequired(true)),

  new SlashCommandBuilder().setName("ticket_settings").setDescription("[ADMIN] Settings: auto-close, limit, ratings")
    .setDefaultMemberPermissions(ADMIN)
    .addIntegerOption(o => o.setName("auto_close_hours").setDescription("Close after X hours without a message (0 = never)").setMinValue(0).setMaxValue(720))
    .addIntegerOption(o => o.setName("max_open").setDescription("Max open tickets per member per category (default 1)").setMinValue(1).setMaxValue(10))
    .addBooleanOption(o => o.setName("ratings").setDescription("Ask the member for a 1–5★ rating on close")),

  new SlashCommandBuilder().setName("category_add").setDescription("[ADMIN] Add a ticket category (panel button)")
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName("name").setDescription("Name, e.g. Support, Purchase, Partnership").setRequired(true).setMaxLength(40))
    .addRoleOption(o => o.setName("staff_role").setDescription("Staff role that sees these tickets").setRequired(true))
    .addStringOption(o => o.setName("emoji").setDescription("Button emoji (default 📩)"))
    .addStringOption(o => o.setName("description").setDescription("Short text shown in the panel").setMaxLength(100))
    .addChannelOption(o => o.setName("parent").setDescription("Discord category where tickets are created").addChannelTypes(ChannelType.GuildCategory))
    .addStringOption(o => o.setName("question").setDescription("Question asked on open, e.g. \"Describe your request\"").setMaxLength(45))
    .addRoleOption(o => o.setName("staff_role_2").setDescription("Second staff role (optional)"))
    .addStringOption(o => o.setName("button").setDescription("Button text (default: \"Create ticket\" or the category name)").setMaxLength(80)),

  new SlashCommandBuilder().setName("category_edit").setDescription("[ADMIN] Edit a category")
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName("name").setDescription("Category to edit").setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName("new_name").setDescription("New name").setMaxLength(40))
    .addRoleOption(o => o.setName("staff_role").setDescription("Replace the staff role"))
    .addStringOption(o => o.setName("emoji").setDescription("Button emoji"))
    .addStringOption(o => o.setName("description").setDescription("Panel text").setMaxLength(100))
    .addChannelOption(o => o.setName("parent").setDescription("Discord category for tickets").addChannelTypes(ChannelType.GuildCategory))
    .addStringOption(o => o.setName("question").setDescription("Question on open (\"none\" to remove)").setMaxLength(45))
    .addRoleOption(o => o.setName("staff_role_2").setDescription("Second staff role"))
    .addStringOption(o => o.setName("button").setDescription("Button text").setMaxLength(80)),

  new SlashCommandBuilder().setName("category_remove").setDescription("[ADMIN] Delete a category")
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName("name").setDescription("Category").setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder().setName("category_list").setDescription("[ADMIN] Show categories and settings")
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder().setName("panel").setDescription("[ADMIN] Post the ticket panel")
    .setDefaultMemberPermissions(ADMIN)
    .addChannelOption(o => o.setName("channel").setDescription("Panel channel (default: this channel)").addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName("title").setDescription("Title").setMaxLength(100))
    .addStringOption(o => o.setName("description").setDescription("Text (\\n for a new line)").setMaxLength(1500))
    .addStringOption(o => o.setName("color").setDescription("Hex color, e.g. #3BA55D"))
    .addStringOption(o => o.setName("image").setDescription("Image/banner URL")),

  new SlashCommandBuilder().setName("add").setDescription("Add a member to the ticket")
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("remove").setDescription("Remove a member from the ticket")
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)),
  new SlashCommandBuilder().setName("rename").setDescription("Rename the ticket")
    .addStringOption(o => o.setName("name").setDescription("New name").setRequired(true).setMaxLength(90)),
  new SlashCommandBuilder().setName("close").setDescription("Close the ticket")
    .addStringOption(o => o.setName("reason").setDescription("Reason").setMaxLength(500)),
  new SlashCommandBuilder().setName("claim").setDescription("Claim the ticket"),
  new SlashCommandBuilder().setName("unclaim").setDescription("Unclaim the ticket"),
  new SlashCommandBuilder().setName("transcript").setDescription("Generate the ticket transcript"),
  new SlashCommandBuilder().setName("ticket_stats").setDescription("[STAFF] Ticket statistics"),
].map(c => c.toJSON());

async function registerCommands(guild) {
  try { await guild.commands.set(commands); console.log(`✅ Commands registered in ${guild.name}`); }
  catch (e) { console.error(`❌ Commands in ${guild.name}:`, e.message); }
}

// ─────────────────────────────────────────────
// Panel
// ─────────────────────────────────────────────
function parseColor(hex, fallback = config.COLOR) {
  const m = String(hex || "").trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? parseInt(m[1], 16) : fallback;
}
function emojiOk(e) {
  if (!e) return null;
  const s = e.trim();
  if (/^<a?:\w+:\d+>$/.test(s)) return s;
  if (/\p{Extended_Pictographic}/u.test(s) && s.length <= 8) return s;
  return null;
}

function buildPanel(g) {
  const p = g.panel || {};
  const embed = new EmbedBuilder()
    .setColor(p.color ?? config.COLOR)
    .setTitle(p.title || "Support")
    .setDescription((p.description || "Welcome to the Support Channel!\n\nOur staff team will be happy to assist you with any questions, issues, or requests. Please provide as much detail as possible when opening a ticket to help us assist you efficiently.")
      + (g.categories.length > 1 && g.categories.some(c => c.description) ? "\n\n" + g.categories.map(c => `${c.emoji ? c.emoji + " " : ""}**${c.name}**${c.description ? ` — ${c.description}` : ""}`).join("\n") : ""));
  if (p.footer !== null) embed.setFooter({ text: p.footer || "FlashTickets" });
  if (p.image) embed.setImage(p.image);

  const rows = [];
  if (g.categories.length === 0) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tk_none").setLabel("No category configured").setStyle(ButtonStyle.Secondary).setDisabled(true)));
  } else if (g.categories.length <= 5) {
    rows.push(new ActionRowBuilder().addComponents(g.categories.map(c => {
      const b = new ButtonBuilder().setCustomId(`tk_open:${c.id}`).setLabel(c.button || (g.categories.length === 1 ? "Create ticket" : c.name)).setStyle(ButtonStyle.Success);
      b.setEmoji(c.emoji || "📩");
      return b;
    })));
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId("tk_select").setPlaceholder("Select a category…")
        .addOptions(g.categories.slice(0, 25).map(c => ({
          label: c.name, value: c.id, description: c.description?.slice(0, 100) || undefined, emoji: c.emoji || undefined,
        })))));
  }
  return { embeds: [embed], components: rows };
}

// Keep the published panel in sync when categories change
async function refreshPanel(guild) {
  const g = G(guild.id);
  if (!g.panel?.channelId || !g.panel?.messageId) return;
  const ch = guild.channels.cache.get(g.panel.channelId);
  const msg = ch ? await ch.messages.fetch(g.panel.messageId).catch(() => null) : null;
  if (msg) await msg.edit(buildPanel(g)).catch(e => console.error("Panel edit:", e.message));
}

// ─────────────────────────────────────────────
// Ticket channel UI
// ─────────────────────────────────────────────
function ticketButtons(t) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tk_close").setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
    t.claimedBy
      ? new ButtonBuilder().setCustomId("tk_unclaim").setLabel("Unclaim").setEmoji("↩️").setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId("tk_claim").setLabel("Claim").setEmoji("🙋").setStyle(ButtonStyle.Secondary),
  );
}
// "Support team ticket controls" shown after closing
function closedButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tk_transcript").setLabel("Transcript").setEmoji("📑").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("tk_reopen").setLabel("Open").setEmoji("🔓").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("tk_delete").setLabel("Delete").setEmoji("⛔").setStyle(ButtonStyle.Secondary),
  );
}
function welcomeEmbed(t, cat, answer) {
  const e = new EmbedBuilder().setColor(config.COLOR)
    .setDescription("Support will be with you shortly.\nTo close this press the close button")
    .setFooter({ text: "FlashTickets" });
  if (answer) e.addFields({ name: cat?.question || "Request", value: answer.slice(0, 1024) });
  return e;
}
// Update the welcome message buttons (Claim / Unclaim, hidden once closed)
async function refreshWelcome(channel, t) {
  if (!t.welcomeId) return;
  const msg = await channel.messages.fetch(t.welcomeId).catch(() => null);
  if (!msg) return;
  await msg.edit({ components: t.status === "open" ? [ticketButtons(t)] : [] }).catch(() => {});
}

// ─────────────────────────────────────────────
// Open
// ─────────────────────────────────────────────
function openCount(guildId, userId, catId) {
  return Object.values(tickets).filter(t => t.guildId === guildId && t.ownerId === userId && t.categoryId === catId && t.status === "open").length;
}

async function openTicket(interaction, cat, answer) {
  const guild = interaction.guild;
  const g = G(guild.id);
  const user = interaction.user;

  const mine = Object.entries(tickets).filter(([, t]) => t.guildId === guild.id && t.ownerId === user.id && t.categoryId === cat.id && t.status === "open");
  if (mine.length >= (g.maxOpen || 1)) {
    return interaction.editReply({ content: `❌ You already have an open ticket: ${mine.map(([id]) => `<#${id}>`).join(", ")}` });
  }

  g.counter = (g.counter || 0) + 1;
  saveGuilds();
  const number = g.counter;
  const name = g.categories.length > 1 ? `${slug(cat.name).slice(0, 20) || "ticket"}-${pad(number)}` : `ticket-${pad(number)}`;

  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
  ];
  for (const rid of cat.staffRoleIds || []) {
    if (guild.roles.cache.has(rid)) overwrites.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] });
  }
  const parent = cat.parentId && guild.channels.cache.get(cat.parentId)?.type === ChannelType.GuildCategory ? cat.parentId : null;

  let channel;
  try {
    channel = await guild.channels.create({
      name, type: ChannelType.GuildText, parent, permissionOverwrites: overwrites,
      topic: `Ticket #${pad(number)} | ${cat.name} | ${user.tag} (${user.id})`,
    });
  } catch (e) {
    console.error("Ticket create:", e.message);
    g.counter--; saveGuilds();
    return interaction.editReply({ content: "❌ Could not create the ticket. Check that the bot has the **Manage Channels** permission (and access to the chosen category)." });
  }

  const t = {
    guildId: guild.id, number, ownerId: user.id, ownerTag: user.tag, categoryId: cat.id, categoryName: cat.name,
    openedAt: Date.now(), lastActivity: Date.now(), claimedBy: null, status: "open", addedUsers: [], answer: answer || null,
  };
  tickets[channel.id] = t;
  saveTickets();

  const pings = `<@${user.id}> Welcome` + ((cat.staffRoleIds || []).length ? `\n${cat.staffRoleIds.map(r => `<@&${r}>`).join(" ")}` : "");
  const welcome = await channel.send({ content: pings, embeds: [welcomeEmbed(t, cat, answer)], components: [ticketButtons(t)], allowedMentions: { users: [user.id], roles: cat.staffRoleIds || [] } }).catch(() => null);
  if (welcome) { t.welcomeId = welcome.id; welcome.pin().catch(() => {}); saveTickets(); }

  log(guild, new EmbedBuilder().setColor(0x57f287).setTitle(`🎫 Ticket opened — #${pad(number)}`)
    .addFields(
      { name: "Member", value: `<@${user.id}> (${user.tag})`, inline: true },
      { name: "Category", value: cat.name, inline: true },
      { name: "Channel", value: `<#${channel.id}>`, inline: true },
    ).setTimestamp());

  return interaction.editReply({ content: `✅ Ticket created: <#${channel.id}>` });
}

// ─────────────────────────────────────────────
// Close / reopen / delete
// ─────────────────────────────────────────────
async function closeTicket(channel, byUser, reason) {
  const t = tickets[channel.id];
  if (!t || t.status !== "open") return false;
  t.status = "closed";
  t.closedAt = Date.now();
  t.closedBy = byUser?.id || client.user.id;
  t.closeReason = reason || null;
  saveTickets();

  // The member (and added users) lose access; staff keep it
  for (const id of [t.ownerId, ...(t.addedUsers || [])]) {
    await channel.permissionOverwrites.edit(id, { ViewChannel: false, SendMessages: false }).catch(() => {});
  }
  await refreshWelcome(channel, t);
  if (!channel.name.startsWith("closed-")) channel.setName(`closed-${channel.name}`.slice(0, 100)).catch(() => {});

  await channel.send({ embeds: [new EmbedBuilder().setColor(0xfee75c)
    .setDescription(`Ticket Closed by <@${t.closedBy}>${reason ? `\n**Reason:** ${reason}` : ""}`)] }).catch(() => {});
  await channel.send({
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setDescription("```Support team ticket controls```")],
    components: [closedButtons()],
  }).catch(() => {});

  // Transcript → logs + DM to the member (+ rating)
  const { file, count } = await buildTranscript(channel, t).catch(e => { console.error("Transcript:", e.message); return {}; });
  const g = G(t.guildId);
  const summary = closeSummary(t, count);
  if (file) log(channel.guild, summary, [file]);
  else log(channel.guild, summary);

  const owner = await client.users.fetch(t.ownerId).catch(() => null);
  if (owner) {
    const dm = {
      embeds: [new EmbedBuilder().setColor(config.COLOR).setTitle(`Your ticket #${pad(t.number)} was closed`)
        .setDescription(`Server: **${channel.guild.name}**\nCategory: **${t.categoryName}**${reason ? `\nReason: ${reason}` : ""}\n\nThe transcript of the conversation is attached.`)],
      files: file ? [new AttachmentBuilder(file.attachment, { name: file.name })] : [],
    };
    if (g.ratings) {
      dm.embeds.push(new EmbedBuilder().setColor(0xfee75c).setDescription("⭐ How was your experience? Leave a rating:"));
      dm.components = [new ActionRowBuilder().addComponents([1, 2, 3, 4, 5].map(n =>
        new ButtonBuilder().setCustomId(`tk_rate:${t.guildId}:${channel.id}:${n}`).setLabel("★".repeat(n)).setStyle(n >= 4 ? ButtonStyle.Success : n === 3 ? ButtonStyle.Primary : ButtonStyle.Secondary)))];
    }
    await owner.send(dm).catch(() => {});
  }
  return true;
}

function closeSummary(t, count) {
  const dur = Math.max(0, (t.closedAt || Date.now()) - t.openedAt);
  const h = Math.floor(dur / 3600000), m = Math.floor((dur % 3600000) / 60000);
  return new EmbedBuilder().setColor(0xed4245).setTitle(`🔒 Ticket closed — #${pad(t.number)}`)
    .addFields(
      { name: "Member", value: `<@${t.ownerId}> (${t.ownerTag || t.ownerId})`, inline: true },
      { name: "Category", value: t.categoryName || "—", inline: true },
      { name: "Claimed by", value: t.claimedBy ? `<@${t.claimedBy}>` : "Nobody", inline: true },
      { name: "Closed by", value: `<@${t.closedBy}>`, inline: true },
      { name: "Duration", value: `${h}h${String(m).padStart(2, "0")}`, inline: true },
      { name: "Messages", value: String(count ?? "—"), inline: true },
      ...(t.closeReason ? [{ name: "Reason", value: t.closeReason.slice(0, 1024) }] : []),
    ).setTimestamp();
}

async function reopenTicket(channel, byUser) {
  const t = tickets[channel.id];
  if (!t || t.status !== "closed") return false;
  t.status = "open";
  t.lastActivity = Date.now();
  t.warned = false;
  t.closedAt = null; t.closedBy = null; t.closeReason = null;
  saveTickets();
  for (const id of [t.ownerId, ...(t.addedUsers || [])]) {
    await channel.permissionOverwrites.edit(id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }).catch(() => {});
  }
  if (channel.name.startsWith("closed-")) channel.setName(channel.name.replace(/^closed-/, "")).catch(() => {});
  await refreshWelcome(channel, t);
  await channel.send({ content: `<@${t.ownerId}>`, embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`🔓 Ticket opened by <@${byUser.id}>`)] }).catch(() => {});
  log(channel.guild, new EmbedBuilder().setColor(0x57f287).setTitle(`🔓 Ticket reopened — #${pad(t.number)}`)
    .setDescription(`<#${channel.id}> by <@${byUser.id}>`).setTimestamp());
  return true;
}

async function deleteTicket(channel, byUser) {
  const t = tickets[channel.id];
  if (!t) return;
  // Deleted while still open → keep a transcript in the logs
  if (t.status === "open") {
    t.closedAt = Date.now(); t.closedBy = byUser.id; t.closeReason = "Deleted";
    const { file, count } = await buildTranscript(channel, t).catch(() => ({}));
    log(channel.guild, closeSummary(t, count), file ? [file] : []);
  }
  await channel.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setDescription("⛔ Ticket will be deleted in a few seconds")] }).catch(() => {});
  delete tickets[channel.id];
  saveTickets();
  setTimeout(() => channel.delete(`Ticket deleted by ${byUser.tag}`).catch(() => {}), 5000);
}

// ─────────────────────────────────────────────
// Logs
// ─────────────────────────────────────────────
function log(guild, embed, files = []) {
  const id = G(guild.id).logChannelId;
  const ch = id ? guild.channels.cache.get(id) : null;
  if (!ch) return;
  ch.send({ embeds: [embed], files }).catch(e => console.error("Log:", e.message));
}

// ─────────────────────────────────────────────
// HTML transcript
// ─────────────────────────────────────────────
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderMarkdown(text, guild) {
  let s = esc(text);
  const codeBlocks = [];
  s = s.replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_, c) => { codeBlocks.push(`<pre>${c}</pre>`); return `\u0000${codeBlocks.length - 1}\u0000`; });
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => {
    const m = guild?.members?.cache?.get(id); const u = client.users?.cache?.get(id);
    return `<span class="mention">@${esc(m?.displayName || u?.username || id)}</span>`;
  });
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="mention">@${esc(guild?.roles?.cache?.get(id)?.name || id)}</span>`);
  s = s.replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="mention">#${esc(guild?.channels?.cache?.get(id)?.name || id)}</span>`);
  s = s.replace(/&lt;t:(\d+)(?::\w)?&gt;/g, (_, ts) => `<span class="ts">${new Date(+ts * 1000).toLocaleString("en-GB", { timeZone: "Europe/Paris" })}</span>`);
  s = s.replace(/&lt;a?:(\w+):(\d+)&gt;/g, (_, n, id) => `<img class="emoji" alt=":${n}:" src="https://cdn.discordapp.com/emojis/${id}.webp?size=44">`);
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>").replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/\|\|(.+?)\|\|/g, '<span class="spoiler">$1</span>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>");
  s = s.replace(/\n/g, "<br>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codeBlocks[+i]);
  return s;
}

function renderEmbed(e, guild) {
  const color = e.color != null ? "#" + e.color.toString(16).padStart(6, "0") : "#4f545c";
  return `<div class="embed" style="border-color:${color}">
    ${e.author?.name ? `<div class="e-author">${esc(e.author.name)}</div>` : ""}
    ${e.title ? `<div class="e-title">${e.url ? `<a href="${esc(e.url)}" target="_blank">${esc(e.title)}</a>` : esc(e.title)}</div>` : ""}
    ${e.description ? `<div class="e-desc">${renderMarkdown(e.description, guild)}</div>` : ""}
    ${(e.fields || []).length ? `<div class="e-fields">${e.fields.map(f => `<div class="e-field${f.inline ? " inline" : ""}"><div class="e-fname">${renderMarkdown(f.name, guild)}</div><div class="e-fval">${renderMarkdown(f.value, guild)}</div></div>`).join("")}</div>` : ""}
    ${e.image?.url ? `<img class="e-img" src="${esc(e.image.url)}">` : ""}
    ${e.footer?.text ? `<div class="e-footer">${esc(e.footer.text)}</div>` : ""}
  </div>`;
}

async function fetchAllMessages(channel, limit = 5000) {
  const out = [];
  let before;
  while (out.length < limit) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    out.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return out.reverse();
}

function transcriptHTML(channel, t, messages) {
  const guild = channel.guild;
  const fmt = ts => new Date(ts).toLocaleString("en-GB", { timeZone: "Europe/Paris" });
  let prevAuthor = null, prevTs = 0;
  const rows = messages.map(m => {
    const grouped = prevAuthor === m.author.id && m.createdTimestamp - prevTs < 5 * 60 * 1000;
    prevAuthor = m.author.id; prevTs = m.createdTimestamp;
    const name = m.member?.displayName || m.author.globalName || m.author.username;
    const color = m.member?.displayHexColor && m.member.displayHexColor !== "#000000" ? m.member.displayHexColor : "#f2f3f5";
    const avatar = m.author.displayAvatarURL?.({ size: 64, extension: "png" }) || "";
    const atts = [...(m.attachments?.values?.() || [])].map(a =>
      /\.(png|jpe?g|gif|webp)$/i.test(a.name || a.url.split("?")[0])
        ? `<a href="${esc(a.url)}" target="_blank"><img class="att-img" src="${esc(a.url)}"></a>`
        : `<a class="att" href="${esc(a.url)}" target="_blank">📎 ${esc(a.name)}</a>`).join("");
    const body = `${m.content ? `<div class="content">${renderMarkdown(m.content, guild)}</div>` : ""}${(m.embeds || []).map(e => renderEmbed(e, guild)).join("")}${atts}`;
    if (grouped) return `<div class="msg grouped"><div class="gutter"><span class="time">${new Date(m.createdTimestamp).toLocaleTimeString("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })}</span></div><div class="body">${body}</div></div>`;
    return `<div class="msg"><img class="avatar" src="${esc(avatar)}"><div class="body"><div class="head"><span class="name" style="color:${esc(color)}">${esc(name)}</span>${m.author.bot ? '<span class="bot">BOT</span>' : ""}<span class="date">${fmt(m.createdTimestamp)}</span></div>${body}</div></div>`;
  }).join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transcript #${pad(t.number)} — ${esc(channel.name)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#313338;color:#dbdee1;font:15px/1.4 "gg sans","Noto Sans",Helvetica,Arial,sans-serif}
header{background:#2b2d31;padding:18px 20px;border-bottom:1px solid #1f2023;display:flex;gap:14px;align-items:center}
header img{width:56px;height:56px;border-radius:50%}header h1{margin:0;font-size:20px;color:#f2f3f5}header p{margin:2px 0 0;color:#b5bac1;font-size:13px}
.meta{display:flex;flex-wrap:wrap;gap:8px 18px;padding:12px 20px;background:#2b2d31;border-bottom:1px solid #1f2023;font-size:13px;color:#b5bac1}.meta b{color:#f2f3f5;font-weight:600}
main{padding:10px 0 30px}.msg{display:flex;gap:14px;padding:4px 20px;margin-top:12px}.msg:hover{background:#2e3035}
.msg.grouped{margin-top:0;padding-top:1px;padding-bottom:1px}.gutter{width:40px;flex:none;text-align:right}.gutter .time{visibility:hidden;font-size:11px;color:#949ba4}.msg.grouped:hover .time{visibility:visible}
.avatar{width:40px;height:40px;border-radius:50%;flex:none}.body{min-width:0;flex:1}.head{display:flex;align-items:baseline;gap:8px}
.name{font-weight:600}.bot{background:#5865f2;color:#fff;font-size:10px;font-weight:600;padding:1px 4px;border-radius:3px}.date{font-size:12px;color:#949ba4}
.content{white-space:normal;word-wrap:break-word}a{color:#00a8fc;text-decoration:none}a:hover{text-decoration:underline}
code{background:#2b2d31;padding:1px 4px;border-radius:4px;font-size:13px}pre{background:#2b2d31;border:1px solid #1e1f22;padding:8px;border-radius:4px;white-space:pre-wrap;font-size:13px}
blockquote{margin:0;padding-left:10px;border-left:4px solid #4e5058}.mention{background:rgba(88,101,242,.3);color:#c9cdfb;padding:0 2px;border-radius:3px}
.spoiler{background:#1e1f22;color:#1e1f22;border-radius:3px}.spoiler:hover{color:inherit}.emoji{width:22px;height:22px;vertical-align:middle}.ts{background:#3f4147;padding:0 3px;border-radius:3px}
.embed{margin-top:6px;max-width:520px;background:#2b2d31;border-left:4px solid;border-radius:4px;padding:10px 14px}
.e-author{font-size:13px;font-weight:600;margin-bottom:4px}.e-title{font-weight:600;color:#f2f3f5;margin-bottom:4px}.e-desc{font-size:14px}
.e-fields{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.e-field{flex:1 1 100%}.e-field.inline{flex:1 1 30%}.e-fname{font-weight:600;font-size:13px;color:#f2f3f5}.e-fval{font-size:14px}
.e-img{max-width:100%;border-radius:4px;margin-top:8px}.e-footer{font-size:12px;color:#949ba4;margin-top:8px}
.att-img{max-width:400px;max-height:300px;border-radius:6px;margin-top:6px;display:block}.att{display:inline-block;margin-top:6px;background:#2b2d31;border:1px solid #1e1f22;padding:8px 12px;border-radius:6px}
footer{text-align:center;color:#949ba4;font-size:12px;padding:16px}
@media(max-width:600px){.msg{padding:4px 12px;gap:10px}.att-img{max-width:100%}}
</style></head><body>
<header>${guild.iconURL() ? `<img src="${esc(guild.iconURL({ size: 128, extension: "png" }))}">` : ""}<div><h1>${esc(guild.name)} — Ticket #${pad(t.number)}</h1><p>#${esc(channel.name)}</p></div></header>
<div class="meta"><span>Member: <b>${esc(t.ownerTag || t.ownerId)}</b></span><span>Category: <b>${esc(t.categoryName || "—")}</b></span><span>Opened: <b>${fmt(t.openedAt)}</b></span>${t.closedAt ? `<span>Closed: <b>${fmt(t.closedAt)}</b></span>` : ""}<span>Messages: <b>${messages.length}</b></span></div>
<main>${rows || '<p style="padding:20px">No messages.</p>'}</main>
<footer>Transcript generated by FlashTickets on ${fmt(Date.now())}</footer>
</body></html>`;
}

async function buildTranscript(channel, t) {
  const messages = await fetchAllMessages(channel);
  const html = transcriptHTML(channel, t, messages);
  const name = `transcript-${pad(t.number)}-${slug(t.ownerTag || t.ownerId).slice(0, 20)}.html`;
  return { file: new AttachmentBuilder(Buffer.from(html, "utf8"), { name }), count: messages.length, html };
}

// ─────────────────────────────────────────────
// Auto-close on inactivity
// ─────────────────────────────────────────────
async function autoCloseSweep() {
  const now = Date.now();
  for (const [chId, t] of Object.entries(tickets)) {
    if (t.status !== "open") continue;
    const hours = G(t.guildId).autoCloseHours || 0;
    if (!hours) continue;
    const idle = now - (t.lastActivity || t.openedAt);
    const limit = hours * 3600000;
    const channel = client.channels.cache.get(chId);
    if (!channel) continue;
    if (idle >= limit) {
      await closeTicket(channel, client.user, `Auto-closed after ${hours}h of inactivity`).catch(e => console.error("Auto-close:", e.message));
    } else if (!t.warned && idle >= limit * 0.75) {
      t.warned = true; saveTickets();
      const left = Math.max(1, Math.round((limit - idle) / 60000));
      channel.send({ content: `<@${t.ownerId}>`, embeds: [new EmbedBuilder().setColor(0xfee75c)
        .setDescription(`⏳ This ticket will be closed automatically in **${left >= 60 ? Math.round(left / 60) + "h" : left + " min"}** if there is no new message.`)] }).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ FlashTickets online: ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) await registerCommands(guild);
  // Forget tickets whose channel was deleted while the bot was off
  for (const chId of Object.keys(tickets)) {
    const t = tickets[chId];
    const guild = client.guilds.cache.get(t.guildId);
    if (guild && !guild.channels.cache.has(chId)) delete tickets[chId];
  }
  saveTickets();
  setInterval(() => autoCloseSweep().catch(() => {}), 5 * 60 * 1000);
});

client.on("guildCreate", guild => registerCommands(guild));

client.on("channelDelete", ch => {
  if (tickets[ch.id]) { delete tickets[ch.id]; saveTickets(); }
});

client.on("messageCreate", msg => {
  if (msg.author.bot || !msg.guild) return;
  const t = tickets[msg.channel.id];
  if (t && t.status === "open") { t.lastActivity = Date.now(); if (t.warned) t.warned = false; saveTickets(); }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isAutocomplete()) return onAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await onCommand(interaction);
    if (interaction.isButton() || interaction.isStringSelectMenu()) return await onComponent(interaction);
    if (interaction.isModalSubmit()) return await onModal(interaction);
  } catch (e) {
    console.error("Interaction error:", e);
    const payload = { content: "❌ Something went wrong.", flags: 64 };
    if (interaction.deferred || interaction.replied) interaction.followUp(payload).catch(() => {});
    else interaction.reply?.(payload).catch(() => {});
  }
});

function onAutocomplete(interaction) {
  const g = G(interaction.guildId);
  const q = String(interaction.options.getFocused() || "").toLowerCase();
  return interaction.respond(g.categories.filter(c => c.name.toLowerCase().includes(q)).slice(0, 25).map(c => ({ name: c.name, value: c.name }))).catch(() => {});
}

// ─────────────────────────────────────────────
// Slash command handlers
// ─────────────────────────────────────────────
const ADMIN_COMMANDS = ["ticket_logs", "ticket_settings", "category_add", "category_edit", "category_remove", "category_list", "panel"];
const eph = (interaction, content) => interaction.reply({ content, flags: 64 });

async function onCommand(interaction) {
  if (!interaction.guild) return eph(interaction, "❌ Use this command in a server.");
  const { commandName: cmd, guild, member, user } = interaction;
  const g = G(guild.id);

  if (ADMIN_COMMANDS.includes(cmd) && !isAdmin(member, user.id)) return eph(interaction, "❌ Admins only (Manage Server permission).");

  if (cmd === "ticket_logs") {
    const ch = interaction.options.getChannel("channel");
    g.logChannelId = ch.id; saveGuilds();
    return eph(interaction, `✅ Logs and transcripts will be sent to <#${ch.id}>.`);
  }

  if (cmd === "ticket_settings") {
    const ac = interaction.options.getInteger("auto_close_hours");
    const mo = interaction.options.getInteger("max_open");
    const rt = interaction.options.getBoolean("ratings");
    if (ac != null) g.autoCloseHours = ac;
    if (mo != null) g.maxOpen = mo;
    if (rt != null) g.ratings = rt;
    saveGuilds();
    return interaction.reply({ embeds: [settingsEmbed(g)], flags: 64 });
  }

  if (cmd === "category_add") {
    if (g.categories.length >= 25) return eph(interaction, "❌ 25 categories maximum.");
    const name = interaction.options.getString("name").trim();
    if (catByName(g, name)) return eph(interaction, `❌ Category **${name}** already exists. Use \`/category_edit\`.`);
    const rawEmoji = interaction.options.getString("emoji");
    const emoji = emojiOk(rawEmoji);
    if (rawEmoji && !emoji) return eph(interaction, "❌ Invalid emoji. Use a single emoji, e.g. 📩");
    const roles = [interaction.options.getRole("staff_role"), interaction.options.getRole("staff_role_2")].filter(Boolean).map(r => r.id);
    const cat = {
      id: newId(), name, emoji,
      description: interaction.options.getString("description") || null,
      staffRoleIds: [...new Set(roles)],
      parentId: interaction.options.getChannel("parent")?.id || null,
      question: interaction.options.getString("question") || null,
      button: interaction.options.getString("button") || null,
    };
    g.categories.push(cat); saveGuilds();
    await refreshPanel(guild);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("✅ Category added").setDescription(catLine(cat) +
      (g.panel ? "\n\nThe panel was updated." : "\n\nPost the panel with `/panel`."))], flags: 64 });
  }

  if (cmd === "category_edit") {
    const cat = catByName(g, interaction.options.getString("name"));
    if (!cat) return eph(interaction, "❌ Category not found. See `/category_list`.");
    const newName = interaction.options.getString("new_name");
    if (newName) {
      if (catByName(g, newName) && catByName(g, newName) !== cat) return eph(interaction, "❌ That name is already taken.");
      cat.name = newName.trim();
    }
    const role = interaction.options.getRole("staff_role");
    const role2 = interaction.options.getRole("staff_role_2");
    if (role) cat.staffRoleIds = [role.id, ...(role2 ? [role2.id] : cat.staffRoleIds.slice(1))].filter((v, i, a) => a.indexOf(v) === i);
    else if (role2) cat.staffRoleIds = [cat.staffRoleIds[0], role2.id].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    const rawEmoji = interaction.options.getString("emoji");
    if (rawEmoji) { const e = emojiOk(rawEmoji); if (!e) return eph(interaction, "❌ Invalid emoji."); cat.emoji = e; }
    const desc = interaction.options.getString("description"); if (desc) cat.description = desc;
    const parent = interaction.options.getChannel("parent"); if (parent) cat.parentId = parent.id;
    const btn = interaction.options.getString("button"); if (btn) cat.button = btn;
    const q = interaction.options.getString("question"); if (q) cat.question = /^none$/i.test(q.trim()) ? null : q;
    saveGuilds();
    await refreshPanel(guild);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle("✅ Category updated").setDescription(catLine(cat))], flags: 64 });
  }

  if (cmd === "category_remove") {
    const cat = catByName(g, interaction.options.getString("name"));
    if (!cat) return eph(interaction, "❌ Category not found.");
    g.categories = g.categories.filter(c => c !== cat); saveGuilds();
    await refreshPanel(guild);
    return eph(interaction, `🗑️ Category **${cat.name}** deleted. Open tickets stay in place.`);
  }

  if (cmd === "category_list") {
    return interaction.reply({ embeds: [settingsEmbed(g), new EmbedBuilder().setColor(config.COLOR).setTitle("🗂️ Categories")
      .setDescription(g.categories.length ? g.categories.map(catLine).join("\n\n") : "None yet. Add one with `/category_add`.")], flags: 64 });
  }

  if (cmd === "panel") {
    if (!g.categories.length) return eph(interaction, "❌ Add a category first with `/category_add`.");
    const ch = interaction.options.getChannel("channel") || interaction.channel;
    const title = interaction.options.getString("title");
    const desc = interaction.options.getString("description");
    const color = interaction.options.getString("color");
    const image = interaction.options.getString("image");
    g.panel = {
      ...(g.panel || {}),
      ...(title ? { title } : {}),
      ...(desc ? { description: desc.replace(/\\n/g, "\n") } : {}),
      ...(color ? { color: parseColor(color) } : {}),
      ...(image ? { image: /^https?:\/\//.test(image) ? image : null } : {}),
    };
    // Old panel message is removed so only one stays active
    if (g.panel.channelId && g.panel.messageId) {
      const old = await guild.channels.cache.get(g.panel.channelId)?.messages.fetch(g.panel.messageId).catch(() => null);
      if (old) old.delete().catch(() => {});
    }
    const sent = await ch.send(buildPanel(g)).catch(e => { console.error("Panel:", e.message); return null; });
    if (!sent) return eph(interaction, `❌ Cannot send messages in <#${ch.id}>.`);
    g.panel.channelId = ch.id; g.panel.messageId = sent.id; saveGuilds();
    return eph(interaction, `✅ Panel posted in <#${ch.id}>.`);
  }

  if (cmd === "ticket_stats") {
    if (!isStaff(member, user.id, g, null)) return eph(interaction, "❌ Staff only.");
    const mine = Object.values(tickets).filter(t => t.guildId === guild.id);
    const open = mine.filter(t => t.status === "open");
    const byCat = g.categories.map(c => `${c.emoji || "•"} ${c.name}: **${open.filter(t => t.categoryId === c.id).length}** open`);
    const r = g.ratingStats || { count: 0, sum: 0 };
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(config.COLOR).setTitle("📊 Tickets").setDescription([
      `Total created: **${g.counter || 0}**`,
      `Open: **${open.length}** · Closed (not deleted): **${mine.length - open.length}**`,
      `Unclaimed: **${open.filter(t => !t.claimedBy).length}**`,
      r.count ? `Average rating: **${(r.sum / r.count).toFixed(2)}★** (${r.count} ratings)` : "Average rating: —",
      "", ...byCat,
    ].join("\n"))], flags: 64 });
  }

  // ── Commands used inside a ticket ──
  const t = tickets[interaction.channelId];
  if (!t) return eph(interaction, "❌ Use this command inside a ticket.");
  const cat = catOf(g, t.categoryId);
  const staff = isStaff(member, user.id, g, cat);

  if (cmd === "close") {
    if (!staff && user.id !== t.ownerId) return eph(interaction, "❌ You can't close this ticket.");
    if (t.status !== "open") return eph(interaction, "❌ This ticket is already closed.");
    await interaction.reply({ content: "🔒 Closing…", flags: 64 });
    await closeTicket(interaction.channel, user, interaction.options.getString("reason"));
    return;
  }

  if (!staff) return eph(interaction, "❌ Staff of this category only.");

  if (cmd === "add" || cmd === "remove") {
    const target = interaction.options.getUser("user");
    if (target.id === t.ownerId) return eph(interaction, "❌ That's the ticket owner.");
    if (cmd === "add") {
      await interaction.channel.permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
      t.addedUsers = [...new Set([...(t.addedUsers || []), target.id])];
    } else {
      await interaction.channel.permissionOverwrites.delete(target.id).catch(() => {});
      t.addedUsers = (t.addedUsers || []).filter(id => id !== target.id);
    }
    saveTickets();
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(cmd === "add" ? 0x57f287 : 0xed4245)
      .setDescription(cmd === "add" ? `➕ <@${target.id}> was added to the ticket.` : `➖ <@${target.id}> was removed from the ticket.`)] });
  }

  if (cmd === "rename") {
    const name = slug(interaction.options.getString("name")).slice(0, 90);
    if (!name) return eph(interaction, "❌ Invalid name.");
    await interaction.channel.setName(t.status === "closed" ? `closed-${name}` : name);
    return eph(interaction, `✏️ Ticket renamed to **${name}**. (Discord allows 2 renames per 10 min.)`);
  }

  if (cmd === "claim" || cmd === "unclaim") return claimToggle(interaction, t, cmd === "claim");

  if (cmd === "transcript") {
    await interaction.deferReply({ flags: 64 });
    const { file } = await buildTranscript(interaction.channel, t);
    return interaction.editReply({ content: "📄 Transcript:", files: [file] });
  }
}

async function claimToggle(interaction, t, claim) {
  const user = interaction.user;
  if (t.status !== "open") return eph(interaction, "❌ This ticket is closed.");
  if (claim) {
    if (t.claimedBy) return eph(interaction, `❌ Already claimed by <@${t.claimedBy}>.`);
    t.claimedBy = user.id;
  } else {
    if (!t.claimedBy) return eph(interaction, "❌ Nobody has claimed this ticket.");
    if (t.claimedBy !== user.id && !isAdmin(interaction.member, user.id)) return eph(interaction, `❌ Only <@${t.claimedBy}> (or an admin) can unclaim it.`);
    t.claimedBy = null;
  }
  saveTickets();
  await refreshWelcome(interaction.channel, t);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(claim ? 0x57f287 : 0xfee75c)
    .setDescription(claim ? `🙋 <@${user.id}> claimed this ticket.` : `↩️ <@${user.id}> unclaimed this ticket.`)] });
}

function catLine(c) {
  return `${c.emoji ? c.emoji + " " : ""}**${c.name}**${c.description ? ` — ${c.description}` : ""}\n` +
    `Staff: ${(c.staffRoleIds || []).map(r => `<@&${r}>`).join(", ") || "—"} · Category: ${c.parentId ? `<#${c.parentId}>` : "none"}` +
    (c.question ? `\nQuestion: "${c.question}"` : "");
}
function settingsEmbed(g) {
  return new EmbedBuilder().setColor(config.COLOR).setTitle("⚙️ Settings").setDescription([
    `Logs / transcripts: ${g.logChannelId ? `<#${g.logChannelId}>` : "not set (`/ticket_logs`)"}`,
    `Auto-close: **${g.autoCloseHours ? "after " + g.autoCloseHours + "h of inactivity" : "off"}**`,
    `Max open tickets per member per category: **${g.maxOpen || 1}**`,
    `Rating on close: **${g.ratings ? "on" : "off"}**`,
    `Panel: ${g.panel?.channelId ? `<#${g.panel.channelId}>` : "not posted (`/panel`)"}`,
  ].join("\n"));
}

// ─────────────────────────────────────────────
// Buttons / select menus
// ─────────────────────────────────────────────
async function startOpen(interaction, catId) {
  const g = G(interaction.guildId);
  const cat = catOf(g, catId);
  if (!cat) return eph(interaction, "❌ This category no longer exists.");
  if (openCount(interaction.guildId, interaction.user.id, cat.id) >= (g.maxOpen || 1)) {
    const ids = Object.entries(tickets).filter(([, t]) => t.guildId === interaction.guildId && t.ownerId === interaction.user.id && t.categoryId === cat.id && t.status === "open").map(([id]) => `<#${id}>`);
    return eph(interaction, `❌ You already have an open ticket: ${ids.join(", ")}`);
  }
  if (cat.question) {
    return interaction.showModal(new ModalBuilder().setCustomId(`tk_modal:${cat.id}`).setTitle(`${cat.name}`.slice(0, 45))
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("answer").setLabel(cat.question.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000))));
  }
  await interaction.deferReply({ flags: 64 });
  return openTicket(interaction, cat, null);
}

async function onComponent(interaction) {
  const id = interaction.customId;

  // Rating from DM
  if (id.startsWith("tk_rate:")) {
    const [, guildId, , n] = id.split(":");
    const stars = +n;
    const g = G(guildId);
    g.ratingStats = g.ratingStats || { count: 0, sum: 0 };
    g.ratingStats.count++; g.ratingStats.sum += stars; saveGuilds();
    await interaction.update({ components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tk_rated").setLabel(`Thanks! ${"★".repeat(stars)}${"☆".repeat(5 - stars)}`).setStyle(ButtonStyle.Success).setDisabled(true))] }).catch(() => {});
    const guild = client.guilds.cache.get(guildId);
    const ticketNo = interaction.message.embeds[0]?.title?.match(/#(\d+)/)?.[1];
    if (guild) log(guild, new EmbedBuilder().setColor(0xfee75c).setTitle(`⭐ New rating${ticketNo ? ` — ticket #${ticketNo}` : ""}`)
      .setDescription(`<@${interaction.user.id}>: **${"★".repeat(stars)}${"☆".repeat(5 - stars)}** (${stars}/5)`).setTimestamp());
    return;
  }

  if (!interaction.guild) return;
  if (id.startsWith("tk_open:")) return startOpen(interaction, id.split(":")[1]);
  if (id === "tk_select") {
    // Reset the menu so the same category can be picked again
    interaction.message.edit(buildPanel(G(interaction.guildId))).catch(() => {});
    return startOpen(interaction, interaction.values[0]);
  }

  const t = tickets[interaction.channelId];
  if (!t) return eph(interaction, "❌ Ticket not found (already deleted?).");
  const g = G(interaction.guildId);
  const cat = catOf(g, t.categoryId);
  const staff = isStaff(interaction.member, interaction.user.id, g, cat);
  const owner = interaction.user.id === t.ownerId;

  if (id === "tk_close") {
    if (!staff && !owner) return eph(interaction, "❌ You can't close this ticket.");
    if (t.status !== "open") return eph(interaction, "❌ Already closed.");
    return interaction.reply({ content: "Are you sure you would like to close this ticket?", flags: 64, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tk_close_yes").setLabel("Close").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("tk_close_no").setLabel("Cancel").setStyle(ButtonStyle.Secondary))] });
  }
  if (id === "tk_close_no") return interaction.update({ content: "Cancelled.", components: [] });
  if (id === "tk_close_yes") {
    if (!staff && !owner) return eph(interaction, "❌ Not allowed.");
    await interaction.update({ content: "🔒 Closing…", components: [] });
    await closeTicket(interaction.channel, interaction.user, null);
    return;
  }
  if (id === "tk_claim" || id === "tk_unclaim") {
    if (!staff) return eph(interaction, "❌ Staff only.");
    return claimToggle(interaction, t, id === "tk_claim");
  }

  // Closed-ticket controls: staff only
  if (!staff) return eph(interaction, "❌ Staff only.");
  if (id === "tk_reopen") {
    if (t.status !== "closed") return eph(interaction, "❌ The ticket is already open.");
    await interaction.deferUpdate();
    await interaction.message.edit({ components: [] }).catch(() => {});
    await reopenTicket(interaction.channel, interaction.user);
    return;
  }
  if (id === "tk_transcript") {
    await interaction.deferReply({ flags: 64 });
    const { file } = await buildTranscript(interaction.channel, t);
    return interaction.editReply({ content: "📄 Transcript:", files: [file] });
  }
  if (id === "tk_delete") {
    await interaction.deferUpdate();
    return deleteTicket(interaction.channel, interaction.user);
  }
}

async function onModal(interaction) {
  if (interaction.customId.startsWith("tk_modal:")) {
    const g = G(interaction.guildId);
    const cat = catOf(g, interaction.customId.split(":")[1]);
    if (!cat) return eph(interaction, "❌ This category no longer exists.");
    await interaction.deferReply({ flags: 64 });
    return openTicket(interaction, cat, interaction.fields.getTextInputValue("answer"));
  }

}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
process.on("unhandledRejection", e => console.error("Unhandled:", e));

if (require.main === module) {
  if (!config.BOT_TOKEN) {
    console.error("❌ TICKETS_BOT_TOKEN is missing. On the VM: setx TICKETS_BOT_TOKEN \"your-token\" then reopen the terminal.");
    process.exit(1);
  }
  client.login(config.BOT_TOKEN);
}

module.exports = { client, autoCloseSweep, transcriptHTML, renderMarkdown, buildPanel, G, tickets, guilds, closeSummary, emojiOk, slug };
