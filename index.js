require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const bigInt = require('big-integer');

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint - used by cron-job.org to keep server awake
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), message: 'Server is alive! 🚀' });
});


// Initialize Supabase with Service Role Key (Admin access to update balances)
const supabaseUrl = process.env.SUPABASE_URL || 'https://mqollrgwuqdudwaczsty.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || 'YOUR_SUPABASE_SERVICE_ROLE_KEY';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Initialize Telegram Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN_HERE');

// Initialize MTProto Client (For unlimited streaming)
const apiId = 36663397;
const apiHash = '6663349d5f967cfb3d242cedfd4fcdbc';
const stringSession = new StringSession(process.env.SESSION_STRING || '1AgAOMTQ5LjE1NC4xNjcuNTEBu25gw4tJr2j9hKSSbncna6ardj4jBOpIWdAs6l9veF/pusToT4qHMFqpbV7C7DkBn2y0HUsXQTGhv9HZ3yGpuamxeYKKS23q3e0LaanpOqASZVUOq7gllvDXsa39chOe5MRQ8CcoEsqmST3oUOTurt64HihGIrQq//xxtlWDN95sRzSdHaE99mX4A9AqsRSLn+WOeHYS6xRYO7AP+Oy8CoIB7Z2EKO1uiIhwOz1cnlPQXK7uUHMJzS8EHm6mb0wFBIKai106XdiVi7a6Flib36gEjJQbvsJntWSMfcKfSaU9HyeaRKXtfb5m/j3hVflOBqELzq7SYVGxMYR1iLocw+k=');

const mtprotoClient = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

(async () => {
    try {
        console.log('Connecting MTProto client for streaming...');
        await mtprotoClient.connect();
        console.log('MTProto client connected successfully! 🚀');
    } catch (err) {
        console.error('Failed to connect MTProto client:', err);
    }
})();

// ==========================================
// 1. PAYMENT SYSTEM (Telegram Stars)
// ==========================================

// API Endpoint to generate invoice link for the Flutter Mini App
app.post('/api/create-invoice', async (req, res) => {
    try {
        const { telegram_id, amount } = req.body; // e.g., amount = 50 (stars)

        if (!telegram_id || !amount) {
            return res.status(400).json({ error: 'Missing telegram_id or amount' });
        }

        // Create an invoice link for Telegram Stars (Currency: XTR, Provider Token: "")
        const invoiceLink = await bot.telegram.createInvoiceLink({
            title: `شحن ${amount} عملة`,
            description: `شحن رصيدك بـ ${amount} عملة معدنية لمشاهدة الأنمي`,
            payload: JSON.stringify({ telegram_id, amount }), // Store data to read later on success
            provider_token: "", // Must be empty for Telegram Stars
            currency: "XTR", // Telegram Stars currency code
            prices: [{ label: `${amount} Coins`, amount: amount }], // amount in smallest units
        });

        res.json({ invoice_url: invoiceLink });
    } catch (error) {
        console.error('Invoice creation error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Telegram Webhook: Handle Pre-checkout Query
bot.on('pre_checkout_query', async (ctx) => {
    // Approve the checkout
    await ctx.answerPreCheckoutQuery(true);
});

// Telegram Webhook: Handle Successful Payment
bot.on('successful_payment', async (ctx) => {
    try {
        const paymentInfo = ctx.message.successful_payment;
        const payload = JSON.parse(paymentInfo.invoice_payload);
        
        const telegramId = payload.telegram_id;
        const addedCoins = payload.amount;

        // Update the user's coin balance in Supabase
        // We use an RPC function or a direct select/update. 
        // For simplicity, let's fetch current and add.
        const { data: user, error: fetchErr } = await supabase
            .from('users')
            .select('coins_balance')
            .eq('telegram_id', telegramId)
            .single();

        if (!fetchErr && user) {
            const newBalance = (user.coins_balance || 0) + addedCoins;
            await supabase
                .from('users')
                .update({ coins_balance: newBalance })
                .eq('telegram_id', telegramId);
                
            console.log(`Successfully recharged ${addedCoins} coins for Telegram ID: ${telegramId}`);
            await ctx.reply(`🎉 تم شحن حسابك بـ ${addedCoins} عملة بنجاح! رصيدك الحالي: ${newBalance} 🪙`);
        } else {
            console.error('User not found in Supabase:', fetchErr);
        }

    } catch (error) {
        console.error('Successful payment handling error:', error);
    }
});

// ==========================================
// 2. STREAMING SYSTEM
// ==========================================

app.get('/stream/:file_id', async (req, res) => {
    try {
        const fileId = req.params.file_id;
        
        // 1. Get the MTProto user's ID and Bot's Username
        const me = await mtprotoClient.getMe();
        const myId = me.id.toString();
        const botInfo = await bot.telegram.getMe();
        const botUsername = botInfo.username;
        
        // 2. Have the Bot send the video by file_id to the User
        const sentMsg = await bot.telegram.sendVideo(myId, fileId);
        
        // 3. Fetch the message using MTProto from the chat with the Bot
        const messages = await mtprotoClient.getMessages(botUsername, { ids: [sentMsg.message_id] });
        if (!messages || messages.length === 0 || !messages[0].media) {
            return res.status(404).send('Media not found');
        }
        
        const media = messages[0].media;
        
        // 4. Delete the message to keep the chat clean
        bot.telegram.deleteMessage(myId, sentMsg.message_id).catch(() => {});

        // 5. Calculate File Size
        let fileSize = 0;
        if (media.document) {
            fileSize = Number(media.document.size);
        } else if (media.video) {
            fileSize = Number(media.video.size);
        } else {
            return res.status(400).send('Invalid media type');
        }
        
        const range = req.headers.range;
        const fileToDownload = media.document || media;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            });
            
            for await (const chunk of mtprotoClient.iterDownload({
                file: fileToDownload,
                offset: bigInt(start),
                limit: chunksize,
                requestSize: 1024 * 1024 // 1MB chunks
            })) {
                res.write(chunk);
            }
            res.end();
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
            });
            
            for await (const chunk of mtprotoClient.iterDownload({
                file: fileToDownload,
                requestSize: 1024 * 1024
            })) {
                res.write(chunk);
            }
            res.end();
        }
    } catch (error) {
        console.error('Streaming error:', error);
        if (!res.headersSent) res.status(500).send('Internal Server Error');
    }
});

// ==========================================
// 3. ADMIN PANEL (Supabase Inserts)
// ==========================================

const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '123456789';

// Middleware to check admin
const verifyAdmin = (req, res, next) => {
    const { telegram_id } = req.body;
    if (telegram_id !== ADMIN_TELEGRAM_ID) {
        return res.status(403).json({ error: 'Unauthorized: Admin only' });
    }
    next();
};

app.post('/api/admin/series', verifyAdmin, async (req, res) => {
    try {
        const { title, description, cover_url, genre, is_exclusive } = req.body;
        
        const { data, error } = await supabase
            .from('series')
            .insert([{ title, description, cover_url, genre, is_exclusive }])
            .select();
            
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add series' });
    }
});

app.post('/api/admin/episodes', verifyAdmin, async (req, res) => {
    try {
        const { series_id, episode_number, title, telegram_file_id, coin_cost } = req.body;
        
        const { data, error } = await supabase
            .from('episodes')
            .insert([{ series_id, episode_number, title, telegram_file_id, coin_cost }])
            .select();
            
        if (error) throw error;
        res.json({ success: true, data });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to add episode' });
    }
});

// ==========================================
// 4. TELEGRAM BOT COMMANDS
// ==========================================

bot.start((ctx) => {
    ctx.reply('مرحباً بك في عالم الأنمي! 🌟\nاضغط على الزر بالأسفل لفتح التطبيق ومشاهدة الحلقات:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚀 افتح التطبيق الآن", web_app: { url: "https://anime-app-ahmad131.surge.sh/" } }]
            ]
        }
    });
});

// Admin Helper: Extract file_id easily!
bot.on('video', (ctx) => {
    const fileId = ctx.message.video.file_id;
    ctx.reply(`✅ تم استخراج الكود بنجاح!\n\nهذا هو الـ File ID الخاص بالفيديو:\n\n\`${fileId}\`\n\nاضغط عليه لنسخه والصقه في الإعدادات!`, {
        parse_mode: 'Markdown'
    });
});

// Start the bot polling (for handling payments and commands)
bot.launch();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Anime Backend is running on port ${PORT}`);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
