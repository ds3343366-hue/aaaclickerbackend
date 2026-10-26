// =========================================================================
// РАЗДЕЛ 1: ИНИЦИАЛИЗАЦИЯ СЕРВЕРА И КОНФИГУРАЦИЯ ОКРУЖЕНИЯ
// =========================================================================
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение мидлваров для обработки данных и CORS
app.use(cors());
app.use(express.json());

// Базовые игровые конфигурации бэкенда
const UPGRADE_CARDS_CONFIG = {
  ceo_card: { basePrice: 100, baseProfit: 10 },
  marketing_card: { basePrice: 500, baseProfit: 45 },
  crypto_card: { basePrice: 2000, baseProfit: 200 }
};

// ИСПРАВЛЕНО: Теперь синтаксис верный, массиву присвоены пороговые значения монет
const BACKEND_LEVELS = Array.of(5000, 25000, 100000, 1000000); // Пороги опыта для уровней 2, 3, 4 и 5

// =========================================================================
// РАЗДЕЛ 2: СХЕМА ДАННЫХ ПОЛЬЗОВАТЕЛЯ MONGOOSE (БАЗА ДАННЫХ)
// =========================================================================
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

  referredBy: { type: String, default: null }, 
  referrals: [{
    userId: { type: String }, 
    username: { type: String },
    bonusClaimed: { type: Boolean, default: false } 
  }],

  dailyStreak: { type: Number, default: 0 }, 
  lastDailyClaim: { type: Date, default: null }, 

  comboClaimedToday: { type: Boolean, default: false }, 
  lastComboDate: { type: String, default: '' }, 
  cipherClaimedToday: { type: Boolean, default: false }, 
  lastCipherDate: { type: String, default: '' }
}, { timestamps: true });

// Метод автоматического расчета пассивного дохода и энергии за время отсутствия
UserSchema.methods.calculateOfflineProgress = function() {
  const now = new Date();
  const secondsOffline = Math.floor((now - this.lastSync) / 1000);

  if (secondsOffline <= 0) return;

  const maxOfflineSeconds = 3 * 60 * 60; 
  const activeOfflineSeconds = Math.min(secondsOffline, maxOfflineSeconds);
  
  if (this.profitPerHour > 0) {
    const profitPerSecond = this.profitPerHour / 3600;
    const earnedOffline = Math.floor(activeOfflineSeconds * profitPerSecond);
    
    this.balance += earnedOffline;
    this.totalEarned += earnedOffline;
  }

  const energyRecoveryRate = 3; 
  const recoveredEnergy = secondsOffline * energyRecoveryRate;
  this.energy = Math.min(this.maxEnergy, this.energy + recoveredEnergy);

  this.lastSync = now;
};

const User = mongoose.model('User', UserSchema);
// =========================================================================
// РАЗДЕЛ 3: ИГРОВЫЕ ЭНДПОИНТЫ API (EXPRESS ROUTES) — НАЧАЛО
// =========================================================================

// 1. СИНХРОНИЗАЦИЯ ДАННЫХ ИГРОКА ПРИ ВХОДЕ В МИНИ-ПРИЛОЖЕНИЕ
app.post('/api/user/sync', async (req, res) => {
  try {
    const { telegramId } = req.body;
    let user = await User.findOne({ telegramId });
    
    if (!user) {
      user = new User({ telegramId });
    }

    user.calculateOfflineProgress();
    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. ОБРАБОТКА ПАКЕТА КЛИКОВ НА ФРОНТЕНДЕ (АНТИЧИТ + АПДЕЙТ ЛИГИ)
app.post('/api/user/click', async (req, res) => {
  try {
    const { telegramId, clicksCount } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });

    user.calculateOfflineProgress();

    const requiredEnergy = clicksCount * user.multitapLevel;
    if (user.energy < requiredEnergy) {
      return res.status(400).json({ error: "Недостаточно энергии для совершения тапов!" });
    }

    user.energy -= requiredEnergy;
    const coinsEarned = clicksCount * user.multitapLevel;
    user.balance += coinsEarned;
    user.totalEarned += coinsEarned; 

    // Расчет лиги на основе исправленного массива BACKEND_LEVELS
    let calculatedLevel = 1;
    for (let i = 0; i < BACKEND_LEVELS.length; i++) {
      if (user.totalEarned >= BACKEND_LEVELS[i]) {
        calculatedLevel = i + 1;
      } else {
        break;
      }
    }
    user.level = calculatedLevel;

    await user.save();
    res.json({ 
      success: true, 
      balance: user.balance, 
      totalEarned: user.totalEarned,
      energy: user.energy, 
      level: user.level 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. УЛУЧШЕНИЕ КАРТОЧЕК В РАЗДЕЛЕ «ШАХТА»
app.post('/api/user/buy-card', async (req, res) => {
  try {
    const { telegramId, cardId } = req.body;
    const cardConfig = UPGRADE_CARDS_CONFIG[cardId];
    if (!cardConfig) return res.status(400).json({ success: false, error: "Карточка не существует" });

    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    user.calculateOfflineProgress();

    const userCardIndex = user.purchasedCards.findIndex(c => c.cardId === cardId);
    const currentLevel = userCardIndex !== -1 ? user.purchasedCards[userCardIndex].level : 0;
    const currentPrice = Math.floor(cardConfig.basePrice * Math.pow(1.5, currentLevel));

    if (user.balance < currentPrice) {
      return res.status(400).json({ success: false, error: "На вашем балансе не хватает монет!" });
    }

    const currentProfit = currentLevel > 0 ? Math.floor(cardConfig.baseProfit * Math.pow(1.2, currentLevel - 1)) : 0;
    const nextProfit = Math.floor(cardConfig.baseProfit * Math.pow(1.2, currentLevel));
    const profitIncrease = nextProfit - currentProfit;

    user.balance -= currentPrice;
    user.profitPerHour += profitIncrease;

    if (userCardIndex !== -1) {
      user.purchasedCards[userCardIndex].level += 1;
    } else {
      user.purchasedCards.push({ cardId: cardId, level: 1 });
    }

    await user.save();
    res.json({
      success: true,
      user: { balance: user.balance, profitPerHour: user.profitPerHour, purchasedCards: user.purchasedCards }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Внутренняя ошибка сервера" });
  }
});
// =========================================================================
// РАЗДЕЛ 4: ИГРОВЫЕ ЭНДПОИНТЫ API — ОКОНЧАНИЕ
// =========================================================================

// 4. СТРИКИ И ЕЖЕДНЕВНЫЙ СБОР НАГРАД Календаря
app.post('/api/user/claim-daily', async (req, res) => {
  try {
    const { telegramId } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    if (user.lastDailyClaim) {
      const lastClaimDate = new Date(user.lastDailyClaim);
      const lastClaimStart = new Date(lastClaimDate.getFullYear(), lastClaimDate.getMonth(), lastClaimDate.getDate()).getTime();
      const msDiff = todayStart - lastClaimStart;
      const oneDayMs = 24 * 60 * 60 * 1000;

      if (msDiff === 0) return res.status(400).json({ success: false, error: "Вы уже получили награду сегодня!" });
      if (msDiff > oneDayMs) user.dailyStreak = 0; 
    }

    user.dailyStreak = (user.dailyStreak % 10) + 1;
    const REWARDS_TABLE = { 1: 500, 2: 1000, 3: 2500, 4: 5000, 5: 15000, 6: 25000, 7: 100000, 8: 500000, 9: 1000000, 10: 5000000 };
    const prizeCoins = REWARDS_TABLE[user.dailyStreak];

    user.balance += prizeCoins;
    user.totalEarned += prizeCoins;
    user.lastDailyClaim = now;

    await user.save();
    res.json({ success: true, dailyStreak: user.dailyStreak, balance: user.balance });
  } catch (error) {
    res.status(500).json({ success: false, error: "Ошибка сервера при обработке стрика" });
  }
});

// Проверка доступности корневого адреса бэкенда
app.get('/', (req, res) => res.send('API кликера стабильно работает онлайн! 🐹'));

// =========================================================================
// РАЗДЕЛ 5: ЗАПУСК TELEGRAM-БОТА С РЕФЕРАЛЬНОЙ СИСТЕМОЙ
// =========================================================================
if (process.env.TELEGRAM_BOT_TOKEN) {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  bot.start(async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const username = ctx.from.username || ctx.from.first_name || "Игрок";
    const startPayload = ctx.payload; 

    let user = await User.findOne({ telegramId });

    if (!user) {
      let referredById = null;

      if (startPayload && startPayload.startsWith('ref')) {
        referredById = startPayload.replace('ref', ''); 
        if (referredById === telegramId) referredById = null;
      }

      user = new User({
        telegramId,
        username,
        referredBy: referredById,
        balance: referredById ? 5000 : 0 
      });
      await user.save();

      if (referredById) {
        try {
          const inviter = await User.findOne({ telegramId: referredById });
          if (inviter) {
            inviter.balance += 5000;
            inviter.totalEarned += 5000;
            inviter.referrals.push({ userId: telegramId, username: username, bonusClaimed: true });
            await inviter.save();
          }
        } catch (err) {
          console.error("Ошибка начисления реф-бонуса:", err);
        }
      }
    }

    ctx.reply(`Привет, ${username}! Добро пожаловать!\nНажми на кнопку ниже, чтобы запустить игру:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Играть! 🐹", web_app: { url: process.env.FRONTEND_URL || "https://vercel.com" } }]
        ]
      }
    });
  });

  bot.launch();
  console.log('🤖 Робот Telegraf успешно активирован');
} else {
  console.warn('⚠️ TELEGRAM_BOT_TOKEN отсутствует в конфигурации окружения. Бот отключен.');
}

// =========================================================================
// РАЗДЕЛ 6: КОННЕКТ К БАЗЕ ДАННЫХ И ЗАПУСК СЕТЕВОГО ПОРТА
// =========================================================================
const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/hamster_clicker';

mongoose.connect(mongoUri)
  .then(() => {
    console.log('✅ База данных MongoDB успешно подключена');
    app.listen(PORT, () => console.log(`🚀 Сервер Express начал слушать порт ${PORT}`));
  })
  .catch((err) => console.error('❌ Сбой при подключении к MongoDB:', err));

