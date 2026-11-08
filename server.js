const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
}

// НАСТРОЙКА БЕЗОПАСНОГО КАНАЛА СВЯЗИ CORS С ВАШИМ РЕАЛЬНЫМ ФРОНТЕНДОМ НА GITHUB PAGES
app.use(cors({
  origin: [
    "https://ds3343366-hue.github.io/clicker-frontend/"
     ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Telegram-Init-Data'],
  credentials: true
}));
app.use(express.json());

const MAX_LEVELS = 30;
const BACKEND_LEVELS = Array.from({length: MAX_LEVELS}, (_, i) => Math.floor(5000 * Math.pow(1.22, i)));

// Жесткие массивы GameFi конфигурации (Накопительный стрик и Конфиг Бак-Энергии)
const DAILY_REWARDS =;
const ENERGY_BOOST_CONFIG = [
  { amount: 300, price: 150 },
  { amount: 500, price: 300 },
  { amount: 700, price: 500 },
  { amount: 1000, price: 800 }
];

const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String, default: '' },
  balance: { type: Number, default: 0 }, 
  totalEarned: { type: Number, default: 0 }, 
  level: { type: Number, default: 1 }, 
  profitPerHour: { type: Number, default: 0 }, 
  lastSync: { type: Date, default: Date.now }, 
  purchasedCards: [{ cardId: { type: String, required: true }, level: { type: Number, default: 1 } }],
  energy: { type: Number, default: 1000 }, 
  maxEnergy: { type: Number, default: 1000 }, 
  multitapLevel: { type: Number, default: 1 }, 
  offlineMiningLevel: { type: Number, default: 1 }, // Уровень АСИК
  beesCountLevel: { type: Number, default: 0 },     // Уровень Пчёл
  energyLimitLevel: { type: Number, default: 1 },   // Циклический уровень бака (1-4)
  referrals: [{ userId: { type: String }, username: { type: String } }],
  lastDailyClaim: { type: String, default: "" },    
  dailyStreak: { type: Number, default: 0 },         
  walletAddress: { type: String, default: "" }
}, { timestamps: true });

function getAsicProfit(lvl) {
  if (lvl <= 1) return 250;
  return Math.floor(250 + ((1000000 - 250) / 29) * (lvl - 1));
}
function getBeesAmount(lvl) {
  if (lvl <= 0) return 0;
  return Math.floor(1 + ((100000 - 1) / 29) * (lvl - 1));
}

UserSchema.methods.recalculateLevel = function() {
  let targetLevel = 1;
  for (let i = 0; i < BACKEND_LEVELS.length; i++) {
    if (this.totalEarned >= BACKEND_LEVELS[i]) targetLevel = i + 2;
    else break;
  }
  this.level = Math.min(MAX_LEVELS, targetLevel);
};

UserSchema.methods.calculateOfflineProgress = function() {
  const now = new Date();
  const secondsOffline = Math.floor((now - (this.lastSync || now)) / 1000);
  if (secondsOffline < 1) return 0;

  const baseCardsProfit = (this.purchasedCards?.find(c => c.cardId === 'ceo_card')?.level || 1) * 10 
                        + (this.purchasedCards?.find(c => c.cardId === 'marketing_card')?.level || 0) * 45
                        + (this.purchasedCards?.find(c => c.cardId === 'crypto_card')?.level || 0) * 200;
  const asicProfit = getAsicProfit(this.offlineMiningLevel);
  const beesProfit = getBeesAmount(this.beesCountLevel) * 3;
  
  this.profitPerHour = baseCardsProfit + asicProfit + beesProfit;
  
  let earnedOffline = 0;
  if (this.profitPerHour > 0) {
    earnedOffline = Math.floor(secondsOffline * (this.profitPerHour / 3600));
    this.balance += earnedOffline;
    this.totalEarned += earnedOffline;
  }
  this.energy = Math.min(this.maxEnergy, this.energy + Math.floor(secondsOffline * (this.maxEnergy / 10800)));
  this.recalculateLevel();
  this.lastSync = now;
  return earnedOffline;
};

const User = mongoose.model('User', UserSchema);
app.post('/api/user/sync', async (req, res) => {
  try {
    const { telegramId, username, localBalance, localTotalEarned } = req.body;
    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ telegramId, username: username || "Пчёлка", balance: localBalance || 0, totalEarned: localTotalEarned || 0 });
    }
    const earnedOffline = user.calculateOfflineProgress();
    await user.save();
    res.json({ success: true, user, earnedOffline });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/user/click', async (req, res) => {
  try {
    const { telegramId, clicksCount } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false });
    user.calculateOfflineProgress();
    const power = user.multitapLevel;
    if (user.energy >= (clicksCount * power)) {
      user.energy -= (clicksCount * power);
      user.balance += (clicksCount * power);
      user.totalEarned += (clicksCount * power);
    }
    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/user/upgrade-stat', async (req, res) => {
  try {
    const { telegramId, type } = req.body;
    let user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false });
    user.calculateOfflineProgress();

    if (type === 'multitap') {
      const cost = user.multitapLevel * 200;
      if (user.balance < cost) return res.status(400).json({ error: "Мало мёда" });
      user.balance -= cost; user.multitapLevel += 1;
    } 
    else if (type === 'offline') { // Улучшение АСИКа улья
      if (user.offlineMiningLevel >= 30) return res.status(400).json({ error: "Максимальный уровень АСИКов!" });
      const cost = user.offlineMiningLevel * 500;
      if (user.balance < cost) return res.status(400).json({ error: "Мало мёда" });
      user.balance -= cost; user.offlineMiningLevel += 1;
    } 
    else if (type === 'bees_count') { // Покупка Пчёл по нарастающей
      if (user.beesCountLevel >= 30) return res.status(400).json({ error: "Максимальный уровень покупки пчёл!" });
      const cost = Math.floor(3500 * Math.pow(1.6, user.beesCountLevel));
      if (user.balance < cost) return res.status(400).json({ error: "Мало мёда" });
      user.balance -= cost; user.beesCountLevel += 1;
    } 
    else if (type === 'energy') { // Умная циклическая подзарядка бака
      const currentConfig = ENERGY_BOOST_CONFIG[user.energyLimitLevel - 1];
      if (user.balance < currentConfig.price) return res.status(400).json({ error: "Мало мёда" });
      if (user.energy >= user.maxEnergy) return res.status(400).json({ error: "Бак энергии уже полон!" });

      user.balance -= currentConfig.price;
      user.energy = Math.min(user.maxEnergy, user.energy + currentConfig.amount);

      // Циклический автоматический возврат уровня: после 4 уровня сбрасывается на 1
      if (user.energyLimitLevel >= 4) {
        user.energyLimitLevel = 1;
      } else {
        user.energyLimitLevel += 1;
      }
    }

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false }); }
});
app.post('/api/user/buy-card', async (req, res) => {
  try {
    const { telegramId, cardId } = req.body;
    const config = { ceo_card: 100, marketing_card: 500, crypto_card: 2000 };
    let user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false });
    
    user.calculateOfflineProgress();
    const userCard = user.purchasedCards.find(c => c.cardId === cardId);
    const lvl = userCard ? userCard.level : (cardId === 'ceo_card' ? 1 : 0);
    const price = Math.floor(config[cardId] * Math.pow(1.5, lvl));

    if (user.balance < price) return res.status(400).json({ error: "Мало мёда" });
    user.balance -= price;
    if (userCard) userCard.level += 1; 
    else user.purchasedCards.push({ cardId, level: 1 });

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false }); }
});

// СИСТЕМА ЕЖЕДНЕВНОГО НАКОПИТЕЛЬНОГО СТРИКА (ОТ 5,000 ДО 100,000 С УЧЕТОМ ПРОПУСКОВ)
app.post('/api/user/claim-daily', async (req, res) => {
  try {
    const { telegramId } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false });

    const todayStr = new Date().toISOString().split('T')[0];
    if (user.lastDailyClaim === todayStr) {
      return res.status(400).json({ success: false, error: "Вы уже забрали пчелиный бонус на сегодня!" });
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Если заходил вчера — стрик растет (до 7 дня), иначе — обнуляется на 1 день
    if (user.lastDailyClaim === yesterdayStr) {
      user.dailyStreak = (user.dailyStreak + 1) % 7;
    } else {
      user.dailyStreak = 0;
    }

    const currentReward = DAILY_REWARDS[user.dailyStreak];
    user.balance += currentReward;
    user.totalEarned += currentReward;
    user.lastDailyClaim = todayStr;

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user, rewardClaimed: currentReward });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Сохранение верифицированного TON кошелька в MongoDB Atlas
app.post('/api/user/save-wallet', async (req, res) => {
  try {
    const { telegramId, walletAddress } = req.body;
    let user = await User.findOne({ telegramId });
    if (user) { user.walletAddress = walletAddress; await user.save(); }
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false }); }
});

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/tap_game';
mongoose.connect(mongoUri).then(() => {
  app.listen(PORT, () => console.log(`🚀 GameFi сервер онлайн на порту ${PORT}`));
});

