const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, toNano } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

// Запуск dotenv в тихом режиме
require('dotenv').config({ silent: true });

const app = express();

// Настройка CORS для вашего фронтенда на GitHub Pages
app.use(cors({
    origin: [
        'https://ds3343366-hue.github.io/clicker-frontend'
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ============================================================================
// БЕЗОПАСНОЕ ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ (БЕЗ ХАРДКОДА ПАРОЛЕЙ)
// ============================================================================
// Код берёт ссылку ИСКЛЮЧИТЕЛЬНО из переменных окружения (вкладка Environment на Render)
const mongoURI = process.env.MONGODB_URI;

if (!mongoURI) {
    console.error('\n❌ Критическая ошибка: Переменная MONGODB_URI не обнаружена в системе!');
    console.error('Пожалуйста, добавьте вашу ссылку на MongoDB Atlas во вкладку Environment на Render.\n');
    process.exit(1); 
}

mongoose.connect(mongoURI)
    .then(() => console.log('📦 Успешное подключение к облачной базе данных MongoDB Atlas'))
    .catch(err => {
        console.error('❌ Ошибка подключения к MongoDB:', err.message);
        process.exit(1);
    });

// Схема пользователя
const userSchema = new mongoose.Schema({
    tg_id: { type: Number, required: true, unique: true },
    balance: { type: Number, default: 0 },
    click_power: { type: Number, default: 1 },
    passive_rate: { type: Number, default: 60 },
    last_claim_time: { type: Date, default: Date.now },
    wallet_address: { type: String, default: null }
});

const User = mongoose.model('User', userSchema);
const BOT_TOKEN = process.env.BOT_TOKEN;
const ITEM_PRICES = {
    asic: 500,
    ton: 2000,
    quantum: 200,
    ai: 1000
};

// Конфигурация TON SDK
const TON_ENDPOINT = process.env.TON_ENDPOINT || 'https://toncenter.com'; 
const TON_API_KEY = process.env.TON_API_KEY; 

const tonClient = new TonClient({
    endpoint: TON_ENDPOINT,
    apiKey: TON_API_KEY
});

// Защищенный Middleware верификации сессии Telegram Mini App
function verifyTelegramWebAppData(req, res, next) {
    const { initData } = req.body;
    
    if (!initData) {
        return res.status(401).json({ error: "Unauthorized: Missing initData" });
    }

    try {
        const q = new URLSearchParams(initData);
        const hash = q.get('hash');
        q.delete('hash');
        
        // Алфавитная сортировка параметров перед проверкой хэша (Строгое требование Telegram API)
        q.sort(); 
        
        const items = Array.from(q.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(items).digest('hex');
        
        if (calculatedHash === hash) {
            const userRaw = q.get('user');
            if (!userRaw) return res.status(400).json({ error: "Invalid user data" });
            
            req.tgUserId = JSON.parse(userRaw).id;
            next();
        } else {
            return res.status(403).json({ error: "Forbidden: Invalid Telegram signature" });
        }
    } catch (e) { 
        return res.status(500).json({ error: "Internal Auth Error", details: e.message }); 
    }
}

// Маршрут синхронизации
app.post('/api/sync', verifyTelegramWebAppData, async (req, res) => {
    const userId = req.tgUserId;
    try {
        let user = await User.findOne({ tg_id: userId });
        if (!user) {
            user = new User({ tg_id: userId });
            await user.save();
        }
        
        const now = Date.now();
        const lastClaim = new Date(user.last_claim_time).getTime();
        const elapsed = now - lastClaim;
        const MIN_CLAIM_TIME = 3 * 60 * 60 * 1000;  
        const MAX_CLAIM_TIME = 8 * 60 * 60 * 1000;  
        
        let effectiveElapsed = Math.min(elapsed, MAX_CLAIM_TIME);
        let minedAmount = elapsed >= MIN_CLAIM_TIME ? (effectiveElapsed / (1000 * 60 * 60)) * user.passive_rate : 0;

        res.json({
            balance: Number(user.balance),
            clickPower: user.click_power,
            passiveRate: user.passive_rate,
            minedAmount: Number(minedAmount.toFixed(2)),
            canClaim: elapsed >= MIN_CLAIM_TIME,
            secondsToClaim: elapsed < MIN_CLAIM_TIME ? Math.ceil((MIN_CLAIM_TIME - elapsed) / 1000) : 0,
            walletAddress: user.wallet_address
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/click', verifyTelegramWebAppData, async (req, res) => {
    try {
        const user = await User.findOne({ tg_id: req.tgUserId });
        if (!user) return res.status(404).json({ error: "User not found" });

        user.balance += user.click_power;
        await user.save();

        res.json({ balance: Number(user.balance) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/claim', verifyTelegramWebAppData, async (req, res) => {
    try {
        const user = await User.findOne({ tg_id: req.tgUserId });
        if (!user) return res.status(404).json({ error: "User not found" });
        
        const elapsed = Date.now() - new Date(user.last_claim_time).getTime();
        if (elapsed < 3 * 60 * 60 * 1000) return res.status(400).json({ error: "Too early" });
        
        let effectiveElapsed = Math.min(elapsed, 8 * 60 * 60 * 1000);
        let mined = (effectiveElapsed / (1000 * 60 * 60)) * user.passive_rate;
        
        user.balance += mined;
        user.last_claim_time = new Date();
        await user.save();

        res.json({ success: true, balance: Number(user.balance) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/buy', verifyTelegramWebAppData, async (req, res) => {
    const { itemType } = req.body;
    if (!ITEM_PRICES[itemType]) return res.status(400).json({ error: "Invalid item type" });
    const serverPrice = ITEM_PRICES[itemType];

    try {
        const user = await User.findOne({ tg_id: req.tgUserId });
        if (!user) return res.status(404).json({ error: "User not found" });
        if (user.balance < serverPrice) return res.status(400).json({ error: "Low balance" });

        user.balance -= serverPrice;

        if (itemType === 'asic') user.passive_rate += 150;
        if (itemType === 'ton') user.passive_rate += 400;
        if (itemType === 'quantum') user.click_power += 1;
        if (itemType === 'ai') user.click_power += 2;

        await user.save();
        res.json({ success: true, balance: Number(user.balance), clickPower: user.click_power, passiveRate: user.passive_rate });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reset', verifyTelegramWebAppData, async (req, res) => {
    try {
        await User.findOneAndUpdate({ tg_id: req.tgUserId }, { balance: 0, click_power: 1, passive_rate: 60, last_claim_time: new Date() });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/connect', verifyTelegramWebAppData, async (req, res) => {
    const { address } = req.body; 
    if (!address) return res.status(400).json({ error: "Wallet address is required" });

    try {
        const user = await User.findOneAndUpdate({ tg_id: req.tgUserId }, { wallet_address: address }, { new: true });
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, walletAddress: user.wallet_address });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/airdrop/run', async (req, res) => {
    const { secretAdminKey, rewardAmountTon } = req.body;
    if (secretAdminKey !== process.env.ADMIN_SECRET_KEY) return res.status(403).json({ error: "Access denied" });
    if (!rewardAmountTon || rewardAmountTon <= 0) return res.status(400).json({ error: "Invalid reward amount" });

    try {
        const participants = await User.find({ wallet_address: { $ne: null }, balance: { $gt: 0 } }).limit(100);
        if (participants.length === 0) return res.json({ success: true, message: "No users for airdrop" });

        const mnemonic = process.env.TON_MNEMONIC.split(' ');
        const keyPair = await mnemonicToPrivateKey(mnemonic);
        const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
        const contract = tonClient.open(wallet);
        let seqno = await contract.getSeqno();

        const messages = [];
        for (const user of participants) {
            messages.push(internal({ to: user.wallet_address, value: toNano(rewardAmountTon.toString()), body: `Cyber Miner AirDrop Reward!`, bounce: false }));
            if (messages.length === 4 || user === participants[participants.length - 1]) {
                await contract.sendTransfer({ secretKey: keyPair.secretKey, seqno, messages: [...messages] });
                messages.length = 0;
                await new Promise(r => setTimeout(r, 4000));
                seqno = await contract.getSeqno();
            }
            user.balance = 0;
            await user.save();
        }
        res.json({ success: true, processedUsers: participants.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => { res.json({ app: "Cyber Miner Cloud Backend", status: "ready" }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 БЭКЕНД УСПЕШНО ЗАПУЩЕН НА ПОРТУ: ${PORT}`);
    console.log(`📦 ОБЛАЧНАЯ КОНФИГУРАЦИЯ БАЗЫ ДАННЫХ ATLAS:`);
    const maskedURI = mongoURI ? mongoURI.replace(/\/\/.*@/, '//***:***@') : "ОТСУТСТВУЕТ!";
    console.log(`   🔌 MONGODB_ATLAS_URI: ${maskedURI}`);
    console.log(`   🤖 BOT_TOKEN:          ${BOT_TOKEN ? '✅ Загружен' : '❌ ОТСУТСТВУЕТ!'}`);
    console.log(`   💎 TON_BLOCKCHAIN:     ${TON_ENDPOINT}`);
    console.log(`==================================================\n`);
});

