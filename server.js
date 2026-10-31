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

app.use(cors());
app.use(express.json());

// Конфигурация карточек (Бизнес-Сот)
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
  lastComboDate: { type: String, default: "" } 
}, { timestamps: true });

// ЖЕЛЕЗНЫЙ МЕТОД: Исправлен расчёт времени (защита от деления на undefined)
UserSchema.methods.calculateOfflineProgress = function() {
  const now = new Date();
  if (!this.lastSync) {
    this.lastSync = now;
    return 0;
  }

  const secondsOffline = Math.floor((now - this.lastSync) / 1000);
  if (secondsOffline < 1) return 0;

  const maxOfflineSeconds = 3 * 60 * 60; 
  const activeOfflineSeconds = Math.min(secondsOffline, maxOfflineSeconds);
  
  const totalHourlyProfit = this.profitPerHour + ((this.offlineMiningLevel - 1) * 50);
  let earnedOffline = 0;

  if (totalHourlyProfit > 0) {
    const profitPerSecond = totalHourlyProfit / 3600;
    earnedOffline = Math.floor(activeOfflineSeconds * profitPerSecond);
    if (earnedOffline > 0) {
      this.balance += earnedOffline;
      this.totalEarned += earnedOffline;
    }
  }

  const recoveryPerSecond = this.maxEnergy / 10800; 
  const recoveredEnergy = Math.floor(secondsOffline * recoveryPerSecond);
  this.energy = Math.min(this.maxEnergy, this.energy + recoveredEnergy);

  this.lastSync = now;
  return earnedOffline;
};

const User = mongoose.model('User', UserSchema);
// 1. СИНХРОНИЗАЦИЯ (ВХОД И ИНТЕРВАЛЬНОЕ ОБНОВЛЕНИЕ)
app.post('/api/user/sync', async (req, res) => {
  try {
    const { telegramId } = req.body;
    let user = await User.findOne({ telegramId });
    if (!user) {
      user = new User({ 
        telegramId, energy: 1000, maxEnergy: 1000, multitapLevel: 1, energyLimitLevel: 1, offlineMiningLevel: 1
      });
    }
    const earnedOffline = user.calculateOfflineProgress();
    await user.save();
    res.json({ success: true, user, earnedOffline });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. УЛУЧШЕНИЕ БУСТОВ
app.post('/api/user/upgrade-stat', async (req, res) => {
  try {
    const { telegramId, type, cost } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    user.calculateOfflineProgress();
    if (user.balance < cost) return res.status(400).json({ success: false, error: "Недостаточно мёда!" });
    user.balance -= cost;

    if (type === 'multitap') {
      user.multitapLevel += 1;
    } else if (type === 'energy') {
      user.energyLimitLevel += 1;
      user.maxEnergy += 500;
      user.energy = user.maxEnergy;
    } else if (type === 'offline') {
      user.offlineMiningLevel += 1;
    }

    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. ПАКЕТ КЛИКОВ
app.post('/api/user/click', async (req, res) => {
  try {
    const { telegramId, clicksCount } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });

    user.calculateOfflineProgress();
    const requiredEnergy = clicksCount * user.multitapLevel;
    if (user.energy < requiredEnergy) return res.status(400).json({ error: "Недостаточно энергии!" });

    user.energy -= requiredEnergy;
    const coinsEarned = clicksCount * user.multitapLevel;
    user.balance += coinsEarned;
    user.totalEarned += coinsEarned; 

    let calculatedLevel = 1;
    for (let i = 0; i < BACKEND_LEVELS.length; i++) {
      if (user.totalEarned >= BACKEND_LEVELS[i]) {
        calculatedLevel = i + 2;
      } else {
        break;
      }
    }
    if (calculatedLevel > MAX_LEVELS) calculatedLevel = MAX_LEVELS;
    user.level = calculatedLevel;

    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. ПОКУПКА/АПГРЕЙД БИЗНЕС-СОТ
app.post('/api/user/buy-card', async (req, res) => {
  try {
    const { telegramId, cardId } = req.body;
    const cardConfig = UPGRADE_CARDS_CONFIG[cardId];
    if (!cardConfig) return res.status(400).json({ success: false, error: "Карта не найдена" });

    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    user.calculateOfflineProgress();
    const userCardIndex = user.purchasedCards.findIndex(c => c.cardId === cardId);
    const currentLevel = userCardIndex !== -1 ? user.purchasedCards[userCardIndex].level : 0;
    const currentPrice = Math.floor(cardConfig.basePrice * Math.pow(1.5, currentLevel));

    if (user.balance < currentPrice) return res.status(400).json({ success: false, error: "Не хватает меда!" });

    const currentProfit = currentLevel > 0 ? Math.floor(cardConfig.baseProfit * Math.pow(1.2, currentLevel - 1)) : 0;
    const nextProfit = Math.floor(cardConfig.baseProfit * Math.pow(1.2, currentLevel));
    
    user.balance -= currentPrice;
    user.profitPerHour += (nextProfit - currentProfit);

    if (userCardIndex !== -1) {
      user.purchasedCards[userCardIndex].level += 1;
    } else {
      user.purchasedCards.push({ cardId: cardId, level: 1 });
    }

    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: "Ошибка сервера" });
  }
});

// 5. ЕЖЕДНЕВНОЕ КОМБО
const CURRENT_SECRET_COMBO = ['ceo_card', 'crypto_card']; 
const COMBO_REWARD = 250000;

app.post('/api/user/check-combo', async (req, res) => {
  try {
    const { telegramId, cardId } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    const todayStr = new Date().toISOString().split('T')[0];

    if (user.lastComboDate !== todayStr && user.todayCombo.length > 0 && user.lastComboDate !== "COMPLETED_" + todayStr) {
      user.todayCombo = [];
    }

    if (user.lastComboDate === "COMPLETED_" + todayStr) {
      return res.json({ success: true, user, msg: "Комбо на сегодня уже выполнено!" });
    }

    if (CURRENT_SECRET_COMBO.includes(cardId) && !user.todayCombo.includes(cardId)) {
      user.todayCombo.push(cardId);
      user.lastComboDate = todayStr;

      if (user.todayCombo.length === CURRENT_SECRET_COMBO.length) {
        user.balance += COMBO_REWARD;
        user.totalEarned += COMBO_REWARD;
        user.lastComboDate = "COMPLETED_" + todayStr;
        await user.save();
        return res.json({ success: true, user, comboCompleted: true, reward: COMBO_REWARD });
      }
    }

    await user.save();
    res.json({ success: true, user, comboCompleted: false });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => res.send('API пчелиного кликера стабильно работает онлайн! 🐝'));

if (bot) {
  bot.start(async (ctx) => {
    try {
      const telegramId = ctx.from.id.toString();
      const username = ctx.from.username || ctx.from.first_name || "Пчёлка";
      let startPayload = ctx.payload ? ctx.payload.toString().trim() : ""; 

      let user = await User.findOne({ telegramId });
      
      if (!user) {
        let referredById = null;
        if (startPayload && startPayload.toLowerCase().startsWith('ref')) {
          referredById = startPayload.substring(3).trim(); 
          if (referredById === telegramId || referredById === "") referredById = null;
        }

        user = new User({ 
          telegramId, username, referredBy: referredById, 
          balance: referredById ? 5000 : 0, totalEarned: referredById ? 5000 : 0
        });
        await user.save();

        if (referredById) {
          try {
            const inviter = await User.findOne({ telegramId: referredById });
            if (inviter) {
              inviter.balance += 5000; inviter.totalEarned += 5000;
              const alreadyRef = inviter.referrals.some(r => r.userId === telegramId);
              if (!alreadyRef) {
                inviter.referrals.push({ userId: telegramId, username: username, bonusClaimed: true });
              }
              await inviter.save();
              bot.telegram.sendMessage(referredById, `🐝 В твой рой вступила новая пчёлка @${username}! Тебе начислено +5000 🍯`).catch(() => {});
            }
          } catch (refErr) {}
        }
      }

      ctx.reply(`Привет, ${username}! Добро пожаловать в улей Tap Game! 🐝`, {
        reply_markup: { inline_keyboard: [[{ text: "Развивать Улей! 🍯", web_app: { url: process.env.FRONTEND_URL || "https://github.io" } }]] }
      });

    } catch (err) { 
      ctx.reply("Добро пожаловать в улей! Нажми на кнопку ниже, чтобы запустить игру 🐝", {
        reply_markup: { inline_keyboard: [[{ text: "Развивать Улей! 🍯", web_app: { url: "https://ds3343366-hue.github.io/clicker-frontend/" } }]] }
      }).catch(() => {});
    }
  });
}

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/tap_game';
mongoose.connect(mongoUri).then(async () => {
  console.log('✅ База данных MongoDB Atlas успешно подключена');
  if (bot) {
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      bot.launch();
      console.log('🤖 Telegram Бот успешно запущен в режиме Polling!');
    } catch (botErr) { console.error(botErr); }
  }
  app.listen(PORT, () => console.log(`🚀 Сервер Express начал слушать порт ${PORT}`));
});

