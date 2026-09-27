'use strict';

/**
 * Discord Bot & Logging Integration for Anti-Cheat Portal
 * - Live login telemetry (Google, Discord, Local Admin) with IP and Geo-location
 * - Live cheat detection alerts and banned hash detections
 * - Traffic telemetry and view counts
 * - Slash command: /setup-log (creates private category and log channels)
 * - Slash command: /status (checks portal health and statistics)
 * - Slash command: /test-log (sends a test alert to verify setup)
 */

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const store = require('./db');

let client = null;
let isReady = false;

// In-memory cache for IP geolocation to avoid rate limiting free lookup APIs
const geoCache = new Map();

async function lookupIp(ip) {
  if (!ip) return { ip: 'Unknown', location: 'Unknown', isp: 'Unknown', flag: '🌐' };
  const clean = String(ip).replace(/^::ffff:/, '').trim();
  if (['127.0.0.1', '::1', 'localhost'].includes(clean) || clean.startsWith('10.') || clean.startsWith('192.168.') || clean.startsWith('172.16.')) {
    return { ip: clean, location: 'Localhost / Private Network', isp: 'Internal', flag: '💻' };
  }
  if (geoCache.has(clean)) return geoCache.get(clean);

  try {
    const res = await fetch(`http://ip-api.com/json/${clean}?fields=status,country,countryCode,regionName,city,isp,org`, {
      signal: AbortSignal.timeout(3500),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'success') {
        const flag = data.countryCode ? getFlagEmoji(data.countryCode) : '🌐';
        const location = [data.city, data.regionName, data.country].filter(Boolean).join(', ') || 'Unknown';
        const info = {
          ip: clean,
          location,
          isp: data.isp || data.org || 'Unknown',
          flag,
        };
        geoCache.set(clean, info);
        return info;
      }
    }
  } catch (err) {
    // lookup failed or timed out
  }

  const fallback = { ip: clean, location: 'Public IP', isp: 'Unknown', flag: '🌐' };
  geoCache.set(clean, fallback);
  return fallback;
}

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function formatUserAgent(ua) {
  if (!ua) return 'Unknown Device';
  const s = String(ua);
  let os = 'Unknown OS';
  if (s.includes('Windows NT 10.0')) os = 'Windows 10/11';
  else if (s.includes('Windows NT 6.3')) os = 'Windows 8.1';
  else if (s.includes('Windows NT 6.1')) os = 'Windows 7';
  else if (s.includes('Mac OS X')) os = 'macOS';
  else if (s.includes('Android')) os = 'Android';
  else if (s.includes('iPhone') || s.includes('iPad')) os = 'iOS';
  else if (s.includes('Linux')) os = 'Linux';

  let browser = 'Unknown Browser';
  if (s.includes('Edg/')) browser = 'Microsoft Edge';
  else if (s.includes('Chrome/')) browser = 'Google Chrome';
  else if (s.includes('Firefox/')) browser = 'Mozilla Firefox';
  else if (s.includes('Safari/') && !s.includes('Chrome/')) browser = 'Apple Safari';
  else if (s.includes('Discord')) browser = 'Discord App';

  return `${browser} on ${os}`;
}

// Post directly to Discord Webhook if configured
async function sendWebhook(url, embed) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed.toJSON()] }),
    });
  } catch (e) {
    console.error('[Discord Webhook Error]:', e.message);
  }
}

// Build Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('setup-log')
    .setDescription('Create a private Anti-Cheat category and configure live logging channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('View current live Anti-Cheat portal status and telemetry'),

  new SlashCommandBuilder()
    .setName('test-log')
    .setDescription('Send a test event to verify the anti-cheat logging channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((cmd) => cmd.toJSON());

async function registerCommands(token, clientId) {
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    console.log('[Discord] Registering global slash commands (/setup-log, /status, /test-log)...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('[Discord] Slash commands registered successfully.');
  } catch (err) {
    console.error('[Discord] Failed to register slash commands:', err.message);
  }
}

function initDiscordBot(token, clientId) {
  if (!token) {
    console.log('[Discord] DISCORD_BOT_TOKEN not provided — Discord bot disabled.');
    return null;
  }

  client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.on('error', (err) => {
    console.error('[Discord Client Error]:', err.message);
  });

  client.once('clientReady', async () => {
    isReady = true;
    console.log(`\n  ✦ Discord Bot connected as: ${client.user.tag} (ID: ${client.user.id})`);
    console.log(`  ✦ Bot Invite Link: https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands\n`);
    store.logEvent('info', 'discord.ready', `Discord bot online as ${client.user.tag}`);

    // Register slash commands
    if (clientId || client.user.id) {
      await registerCommands(token, clientId || client.user.id);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;

      const { commandName } = interaction;

      if (commandName === 'setup-log') {
        await handleSetupLog(interaction);
      } else if (commandName === 'status') {
        await handleStatus(interaction);
      } else if (commandName === 'test-log') {
        await handleTestLog(interaction);
      }
    } catch (err) {
      console.error('[Discord Interaction Error]:', err.message);
    }
  });

  client.login(token).catch((err) => {
    console.error('[Discord] Bot login failed:', err.message);
  });

  return client;
}

async function handleSetupLog(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ This command must be executed within a Discord server.', flags: 64 }).catch(() => {});
    return;
  }

  let deferred = false;
  try {
    await interaction.deferReply({ flags: 64 });
    deferred = true;
  } catch (e) {
    console.warn('[Discord defer warning]:', e.message);
  }

  const sendResponse = async (msg) => {
    try {
      if (deferred) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply({ ...msg, flags: 64 });
      }
    } catch (e) {
      console.error('[Discord Response Error]:', e.message);
    }
  };

  try {
    const guild = interaction.guild;
    const botMember = guild.members.me || await guild.members.fetch(client.user.id);

    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return sendResponse({ content: '❌ The bot needs **Manage Channels** permission in this server to create the private logging category.' });
    }

    // 1. Create Private Category
    const category = await guild.channels.create({
      name: '🛡️ Anti-Cheat Logs',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.id, // @everyone
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: client.user.id, // Bot
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: interaction.user.id, // The admin who set it up
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ],
    });

    // 2. Create Channels inside category
    const loginChan = await guild.channels.create({
      name: '🔒-login-logs',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: 'Live log of Google, Discord, and Admin sign-ins with IP & location telemetry.',
    });

    const alertChan = await guild.channels.create({
      name: '🚨-cheat-alerts',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: 'Live alerts for cheat detections, memory injectors, and suspicious scan findings.',
    });

    const trafficChan = await guild.channels.create({
      name: '📊-traffic-logs',
      type: ChannelType.GuildText,
      parent: category.id,
      topic: 'Website traffic, unique visitor stats, and portal access telemetry.',
    });

    // Save channel IDs in database settings
    store.setSetting('discord_category_id', category.id);
    store.setSetting('discord_login_channel_id', loginChan.id);
    store.setSetting('discord_alert_channel_id', alertChan.id);
    store.setSetting('discord_traffic_channel_id', trafficChan.id);
    store.setSetting('discord_guild_id', guild.id);

    // Send Welcome Embeds
    const loginEmbed = new EmbedBuilder()
      .setTitle('🔒 Live Login Logs Initialized')
      .setDescription('All authentication attempts across **Google**, **Discord**, and **Admin** credentials will be captured here with IP address, device telemetry, and location details.')
      .setColor(0x3b82f6)
      .setTimestamp();
    await loginChan.send({ embeds: [loginEmbed] });

    const alertEmbed = new EmbedBuilder()
      .setTitle('🚨 Live Cheat Alerts Initialized')
      .setDescription('Any player scan with flagged verdicts, blacklisted process hashes, debugger attachments, or memory modifications will trigger an alert here.')
      .setColor(0xef4444)
      .setTimestamp();
    await alertChan.send({ embeds: [alertEmbed] });

    const trafficEmbed = new EmbedBuilder()
      .setTitle('📊 Traffic & Visitor Telemetry Initialized')
      .setDescription('Live visitor count, page views, and website telemetry will be monitored here.')
      .setColor(0x10b981)
      .setTimestamp();
    await trafficChan.send({ embeds: [trafficEmbed] });

    await sendResponse({
      content: `✅ **Anti-Cheat Logging System Configured!**\n\nCreated private category **🛡️ Anti-Cheat Logs** with:\n• <#${loginChan.id}>\n• <#${alertChan.id}>\n• <#${trafficChan.id}>\n\nAll portal logins and cheat alerts will stream here in real time.`,
    });
  } catch (err) {
    console.error('[Discord Setup Error]:', err);
    await sendResponse({ content: `❌ Error setting up channels: \`${err.message}\`` });
  }
}

async function handleStatus(interaction) {
  try {
    const stats = store.getStats();
    const portalUrl = process.env.PUBLIC_URL || 'https://anticheat-gqae.onrender.com';

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Tournament Anti-Cheat · System Status')
      .setURL(portalUrl)
      .setColor(0x3b82f6)
      .addFields(
        { name: '🟢 Portal Health', value: 'Online & Operational', inline: true },
        { name: '👥 Registered Users', value: String(stats.totalUsers || 0), inline: true },
        { name: '🔑 Active PIN Sessions', value: String(stats.activeSessions || 0), inline: true },
        { name: '📋 Total Scans', value: String(stats.totalReports || 0), inline: true },
        { name: '🚨 Flagged Scans', value: String(stats.flaggedReports || 0), inline: true },
        { name: '🌐 Portal URL', value: `[Open Portal](${portalUrl})`, inline: true },
      )
      .setFooter({ text: 'Tournament Anti-Cheat Monitoring Bot' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (e) {
    await interaction.reply({ content: `Error fetching status: ${e.message}`, ephemeral: true });
  }
}

async function handleTestLog(interaction) {
  try {
    await interaction.deferReply({ flags: 64 });
  } catch {}
  try {
    await logLogin({
      provider: 'test',
      user: { name: interaction.user.username, email: 'test@example.com' },
      ip: '8.8.8.8',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0',
    });

    await logCheatAlert({
      pin: 'TEST-9999',
      playerName: 'Cheater_Sample',
      game: 'Counter-Strike 2',
      verdict: 'cheat_detected',
      score: 95,
      findings: [
        { severity: 'high', title: 'Known Hook DLL Detected', detail: 'SpeedHack_Hook.dll found injected into game memory' },
        { severity: 'critical', title: 'Memory Byte Patching', detail: 'Code integrity violation at offset 0x0045A12F' },
      ],
      hostname: 'DESKTOP-SUSPECT',
      ip: '198.51.100.4',
    });

    await interaction.editReply('✅ Test login log and test cheat alert dispatched successfully!').catch(() => {});
  } catch (err) {
    await interaction.editReply(`❌ Test failed: ${err.message}`).catch(() => {});
  }
}

/**
 * Public method to log sign-in events to Discord
 */
async function logLogin({ provider, user, ip, userAgent }) {
  const geo = await lookupIp(ip);
  const device = formatUserAgent(userAgent);

  const colors = {
    google: 0x4285f4,
    discord: 0x5865f2,
    local: 0xf59e0b,
    test: 0x10b981,
  };

  const providerNames = {
    google: 'Google Account',
    discord: 'Discord OAuth',
    local: 'Local Admin Account',
    test: 'Test Event',
  };

  const color = colors[provider] || 0x3b82f6;
  const method = providerNames[provider] || provider;

  const embed = new EmbedBuilder()
    .setTitle(`🟢 User Sign-In · ${user.name || 'Account'}`)
    .setColor(color)
    .addFields(
      { name: '👤 User', value: `**${user.name || 'Admin'}**\n\`${user.email || 'No email'}\``, inline: true },
      { name: '🔑 Method', value: method, inline: true },
      { name: '🌐 IP Address', value: `\`${geo.ip}\``, inline: true },
      { name: `${geo.flag} Location`, value: `${geo.location}\n*ISP: ${geo.isp}*`, inline: false },
      { name: '💻 Device / Browser', value: `\`${device}\``, inline: false },
    )
    .setFooter({ text: 'Tournament Anti-Cheat Security Audit' })
    .setTimestamp();

  if (user.avatarUrl && user.avatarUrl.startsWith('http')) {
    embed.setThumbnail(user.avatarUrl);
  }

  // Send to Discord bot channel if configured
  const channelId = store.getSetting('discord_login_channel_id');
  if (client && isReady && channelId) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [embed] });
      }
    } catch (e) {
      console.error('[Discord Log Error]:', e.message);
    }
  }

  // Also send to webhook if configured
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    await sendWebhook(webhookUrl, embed);
  }
}

/**
 * Public method to log cheat alerts
 */
async function logCheatAlert({ pin, playerName, game, verdict, score, findings, hostname, ip }) {
  const geo = await lookupIp(ip);
  const isCheat = verdict === 'cheat_detected' || verdict === 'suspicious' || score > 40;

  const embed = new EmbedBuilder()
    .setTitle(isCheat ? '🚨 CHEAT DETECTION ALERT' : '📋 Agent Scan Report')
    .setColor(isCheat ? 0xef4444 : 0x10b981)
    .addFields(
      { name: '🎮 Player / Game', value: `**${playerName || 'Anonymous Player'}**\n*${game || 'Unknown Game'}*`, inline: true },
      { name: '🔑 PIN Session', value: `\`${pin || 'N/A'}\``, inline: true },
      { name: '⚖️ Verdict / Score', value: `**${(verdict || 'clean').toUpperCase()}** (Threat Score: ${score || 0}/100)`, inline: true },
      { name: '🖥️ Machine Info', value: `Hostname: \`${hostname || 'Unknown'}\`\nIP: \`${geo.ip}\` (${geo.flag} ${geo.location})`, inline: false },
    );

  if (findings && findings.length > 0) {
    const list = findings.slice(0, 5).map((f) => `• **[${(f.severity || 'WARN').toUpperCase()}]** ${f.title || f.name}: ${f.detail || f.description || ''}`).join('\n');
    embed.addFields({ name: '⚠️ Threat Findings', value: list.slice(0, 1024), inline: false });
  }

  embed.setFooter({ text: 'Tournament Anti-Cheat Telemetry' }).setTimestamp();

  const channelId = store.getSetting('discord_alert_channel_id');
  if (client && isReady && channelId) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [embed] });
      }
    } catch (e) {
      console.error('[Discord Alert Error]:', e.message);
    }
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    await sendWebhook(webhookUrl, embed);
  }
}

/**
 * Public method to log website traffic
 */
let viewCounter = 0;
let lastTrafficReport = Date.now();

async function logTraffic({ path, ip, userAgent }) {
  viewCounter += 1;

  // Post summary every 50 views or every 30 minutes to prevent spamming
  const now = Date.now();
  if (viewCounter >= 50 || (viewCounter > 0 && now - lastTrafficReport > 30 * 60 * 1000)) {
    const geo = await lookupIp(ip);
    const count = viewCounter;
    viewCounter = 0;
    lastTrafficReport = now;

    const embed = new EmbedBuilder()
      .setTitle('📊 Website Traffic Update')
      .setColor(0x10b981)
      .addFields(
        { name: '📈 Recent Page Views', value: `**${count}** page visits`, inline: true },
        { name: '🌐 Latest Access From', value: `${geo.flag} ${geo.location} (\`${geo.ip}\`)`, inline: true },
        { name: '🔗 Latest Path', value: `\`${path || '/'}\``, inline: true },
      )
      .setFooter({ text: 'Tournament Anti-Cheat Traffic Telemetry' })
      .setTimestamp();

    const channelId = store.getSetting('discord_traffic_channel_id');
    if (client && isReady && channelId) {
      try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          await channel.send({ embeds: [embed] });
        }
      } catch (e) {
        console.error('[Discord Traffic Error]:', e.message);
      }
    }

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      await sendWebhook(webhookUrl, embed);
    }
  }
}

module.exports = {
  initDiscordBot,
  logLogin,
  logCheatAlert,
  logTraffic,
};
