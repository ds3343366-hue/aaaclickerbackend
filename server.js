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

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Telegram-Init-Data'],
  credentials: true
}));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, X-Telegram-Init-Data");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

const UPGRADE_CARDS_CONFIG = {
  ceo_card: { basePrice: 100, baseProfit: 10 },
  marketing_card: { basePrice: 500, baseProfit: 45 },
  crypto_card: { basePrice: 2000, baseProfit: 200 }
};

const MAX_LEVELS = 30;
const BACKEND_LEVELS = Array.from({length: MAX_LEVELS}, (_, i) => Math.floor(5000 * Math.pow(1.22, i)));

const UserSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true },
  username: { type: String, default: '' },
  balance: { type: Number, default: 0 }, 
  totalEarned: { type: Number, default: 0 }, 
  level: { type: Number, default: 1 }, 
  profitPerHour: { type: Number, default: 0 }, 
  lastSync: { type: Date, default: Date.now }, 
  purchasedCards: [{
    cardId: { type: String, required: true }, 
    level: { type: Number, default: 1 }      
  }],
  energy: { type: Number, default: 1000 }, 
  maxEnergy: { type: Number, default: 1000 }, 
  multitapLevel: { type: Number, default: 1 }, 
  energyLimitLevel: { type: Number, default: 1 }, 
  offlineMiningLevel: { type: Number, default: 1 }, 
  referredBy: { type: String, default: null }, 
  referrals: [{
    userId: { type: String }, 
    username: { type: String },
    bonusClaimed: { type: Boolean, default: false } 
  }],
  todayCombo: [{ type: String }], 
  lastComboDate: { type: String, default: "" },
  walletAddress: { type: String, default: "" }
}, { timestamps: true });

UserSchema.methods.recalculateLevel = function() {
  let targetLevel = 1;
  for (let i = 0; i < BACKEND_LEVELS.length; i++) {
    if (this.totalEarned >= BACKEND_LEVELS[i]) {
      targetLevel = i + 2; 
    } else {
      break;
    }
  }
  if (targetLevel > MAX_LEVELS) targetLevel = MAX_LEVELS;
  this.level = targetLevel;
};
UserSchema.methods.calculateOfflineProgress = function() {
  const now = new Date();
  if (!this.lastSync) {
    this.lastSync = now;
    return 0;
  }

  const secondsOffline = Math.floor((now - this.lastSync) / 1000);
  if (secondsOffline < 1) return 0;

  if (this.level >= 30) {
    this.lastSync = now;
    return 0;
  }

  const asicHourlyProfit = (this.offlineMiningLevel - 1) * 50;
  const totalHourlyProfit = this.profitPerHour + asicHourlyProfit;
  let earnedOffline = 0;

  if (totalHourlyProfit > 0) {
    const profitPerSecond = totalHourlyProfit / 3600;
    earnedOffline = Math.floor(secondsOffline * profitPerSecond);
    if (earnedOffline > 0) {
      this.balance += earnedOffline;
      this.totalEarned += earnedOffline;
    }
  }

  const recoveryPerSecond = this.maxEnergy / 10800; 
  this.energy = Math.min(this.maxEnergy, this.energy + Math.floor(secondsOffline * recoveryPerSecond));

  this.recalculateLevel();
  this.lastSync = now;
  return earnedOffline;
};

const User = mongoose.model('User', UserSchema);

app.post('/api/user/sync', async (req, res) => {
  try {
    const { telegramId, username, localBalance, localTotalEarned } = req.body;
    if (!telegramId) return res.status(400).json({ success: false, error: "Не указан telegramId" });

    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ 
        telegramId, username: username || "Пчёлка",
        balance: localBalance || 0, totalEarned: localTotalEarned || 0
      });
    } else {
      if (username) user.username = username;
      if (localBalance && localBalance > user.balance) user.balance = localBalance;
      if (localTotalEarned && localTotalEarned > user.totalEarned) user.totalEarned = localTotalEarned;
    }

    const earnedOffline = user.calculateOfflineProgress();
    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user, earnedOffline });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/user/click', async (req, res) => {
  try {
    const { telegramId, clicksCount } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    user.calculateOfflineProgress();
    
    if (clicksCount > 0) {
      const requiredEnergy = clicksCount * user.multitapLevel;
      if (user.energy >= requiredEnergy) {
        user.energy -= requiredEnergy;
        user.balance += (clicksCount * user.multitapLevel);
        user.totalEarned += (clicksCount * user.multitapLevel);
      } else {
        const possibleClicks = Math.floor(user.energy / user.multitapLevel);
        if (possibleClicks > 0) {
          user.energy -= (possibleClicks * user.multitapLevel);
          user.balance += (possibleClicks * user.multitapLevel);
          user.totalEarned += (possibleClicks * user.multitapLevel);
        }
      }
    }

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.post('/api/user/upgrade-stat', async (req, res) => {
  try {
    const { telegramId, type, cost } = req.body;
    let user = await User.findOne({ telegramId });
    
    // ФИКС: Если пользователя нет в БД, создаем его на лету
    if (!user) {
      user = new User({ telegramId, balance: 1000 }); 
    }
    if (user.level >= 30) return res.status(400).json({ success: false, error: "Максимальный уровень!" });

    user.calculateOfflineProgress();
    if (user.balance < (cost || 0)) return res.status(400).json({ success: false, error: "Не хватает мёда!" });
    user.balance -= (cost || 0);

    if (type === 'multitap') user.multitapLevel += 1;
    else if (type === 'energy') {
      user.energyLimitLevel += 1;
      user.maxEnergy += 500;
      user.energy = user.maxEnergy;
    } else if (type === 'offline') user.offlineMiningLevel += 1;

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/user/buy-card', async (req, res) => {
  try {
    const { telegramId, cardId } = req.body;
    const cardConfig = UPGRADE_CARDS_CONFIG[cardId];
    if (!cardConfig) return res.status(400).json({ success: false, error: "Ошибка параметров конфигурации" });

    let user = await User.findOne({ telegramId });
    
    // ФИКС: Создаем профиль на лету, если игрок еще ни разу не отправлял синхронизацию
    if (!user) {
      user = new User({ telegramId, balance: 500 }); 
    }
    if (user.level >= 30) return res.status(400).json({ success: false, error: "Максимальный уровень!" });

    user.calculateOfflineProgress();
    const userCardIndex = user.purchasedCards.findIndex(c => c.cardId === cardId);
    const currentLevel = userCardIndex !== -1 ? user.purchasedCards[userCardIndex].level : 0;
    const currentPrice = Math.floor(cardConfig.basePrice * Math.pow(1.5, currentLevel));

    if (user.balance < currentPrice) return res.status(400).json({ success: false, error: "Не хватает мёда!" });

    const currentProfit = currentLevel > 0 ? Math.floor(cardConfig.baseProfit * Math.pow(1.2, currentLevel - 1)) : 0;
    const nextProfit = Math.floor(cardConfig.baseProfit * Math.pow(1.2, currentLevel));
    
    user.balance -= currentPrice;
    user.profitPerHour += (nextProfit - currentProfit);

    if (userCardIndex !== -1) user.purchasedCards[userCardIndex].level += 1;
    else user.purchasedCards.push({ cardId: cardId, level: 1 });

    user.recalculateLevel();
    await user.save();
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false, error: "Внутренняя ошибка сервера соты" }); }
});

app.post('/api/user/save-wallet', async (req, res) => {
  try {
    const { telegramId, walletAddress } = req.body;
    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ telegramId, username: "Пчёлка TON" });
    }
    user.walletAddress = walletAddress || "";
    await user.save();
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/', (req, res) => res.send('API пчелиного GameFi кликера стабильно работает онлайн! 🐝'));

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/tap_game';
mongoose.connect(mongoUri)
  .then(() => {
    console.log('✅ База данных MongoDB Atlas успешно подключена');
    app.listen(PORT, () => {
      console.log(`🚀 Сервер Express успешно развернут на порту ${PORT}`);
    });
  })
  .catch(err => console.error('Критическая ошибка подключения к MongoDB:', err));

