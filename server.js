// =========================================================================
// РАЗДЕЛ 1: ИНИЦИАЛИЗАЦИЯ СЕРВЕРА И КОНФИГУРАЦИЯ ОКРУЖЕНИЯ (TAP GAME)
// =========================================================================
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

let bot = null; 

// Инициализируем бота Telegraf только при наличии токена
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
}

// Подключение мидлваров для обработки входящих JSON-данных и CORS
app.use(cors());
app.use(express.json());

// Базовые конфигурации бизнес-сот (синхронизировано с фронтендом)
const UPGRADE_CARDS_CONFIG = {
  ceo_card: { basePrice: 100, baseProfit: 10 },
  marketing_card: { basePrice: 500, baseProfit: 45 },
  crypto_card: { basePrice: 2000, baseProfit: 200 }
};

// Числовые пороги меда для перехода на уровни пчелы (2 — Рабочий, 3 — Сборщик, 4 — Охранник, 5 — Королева)
const BACKEND_LEVELS = Array.of(5000, 25000, 100000, 1000000);

// =========================================================================
// РАЗДЕЛ 2: СХЕМА ДАННЫХ ПЧЕЛИНОГО УЛЬЯ MONGOOSE (ДОБАВЛЕНЫ БУСТЫ)
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

  // Характеристики бустов Лаборатории намертво привязаны к схеме Mongoose
  energy: { type: Number, default: 1000 }, 
  maxEnergy: { type: Number, default: 1000 }, 
  multitapLevel: { type: Number, default: 1 }, 
  energyLimitLevel: { type: Number, default: 1 }, 
  offlineMiningLevel: { type: Number, default: 1 }, // ИСПРАВЛЕНО: Добавлено явное поле для пассивного сна

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

// Метод расчета пассивного сбора меда роем за время офлайна (3 часа лимит)
UserSchema.methods.calculateOfflineProgress = function() {
  const now = new Date();
  const secondsOffline = Math.floor((now - this.lastSync) / 1000);

  if (secondsOffline <= 0) return;

  const maxOfflineSeconds = 3 * 60 * 60; 
  const activeOfflineSeconds = Math.min(secondsOffline, maxOfflineSeconds);
  
  // Доход формируется от бизнес-сот + уровня технологий офлайн сна (+50/ч за уровень)
  const totalHourlyProfit = this.profitPerHour + ((this.offlineMiningLevel - 1) * 50);
  
  if (totalHourlyProfit > 0) {
    const profitPerSecond = totalHourlyProfit / 3600;
    const earnedOffline = Math.floor(activeOfflineSeconds * profitPerSecond);
    
    this.balance += earnedOffline;
    this.totalEarned += earnedOffline;
  }

  // Полное восстановление бака занимает строго 3 часа (10800 секунд)
  const recoveryPerSecond = this.maxEnergy / 10800;
  const recoveredEnergy = secondsOffline * recoveryPerSecond;
  this.energy = Math.min(this.maxEnergy, this.energy + recoveredEnergy);

  this.lastSync = now;
};

const User = mongoose.model('User', UserSchema);
// =========================================================================
// РАЗДЕЛ 3: ИГРОВЫЕ ЭНДПОИНТЫ API (EXPRESS ROUTES)
// =========================================================================

// 1. ИСПРАВЛЕНО: СИНХРОНИЗАЦИЯ ДАННЫХ ИГРОКА ПРИ ВХОДЕ В TAP GAME
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

// 2. ИСПРАВЛЕНО: УЛУЧШЕНИЕ И СИНХРОННОЕ СОХРАНЕНИЕ БУСТОВ ЛАБОРАТОРИИ УЛЬЯ В БАЗУ
app.post('/api/user/upgrade-stat', async (req, res) => {
  try {
    const { telegramId, type, cost } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    user.calculateOfflineProgress();

    if (user.balance < cost) {
      return res.status(400).json({ success: false, error: "Недостаточно мёда для улучшения буста!" });
    }

    // Снимаем мёд с баланса игрока
    user.balance -= cost;

    // Повышаем уровень характеристики в схеме Mongoose
    if (type === 'multitap') {
      user.multitapLevel += 1;
    } else if (type === 'energy') {
      user.energyLimitLevel += 1;
      user.maxEnergy += 500; // Повышаем лимит бака на 500 монет
    } else if (type === 'offline') {
      user.offlineMiningLevel += 1; // Повышаем технологию офлайн сна пчелы
    }

    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. ОБРАБОТКА ПАКЕТА КЛИКОВ (АНТИЧИТ + АПДЕЙТ РАНГА ПЧЕЛЫ НА СЕРВЕРЕ)
app.post('/api/user/click', async (req, res) => {
  try {
    const { telegramId, clicksCount } = req.body;
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });

    user.calculateOfflineProgress();

    const requiredEnergy = clicksCount * user.multitapLevel;
    if (user.energy < requiredEnergy) {
      return res.status(400).json({ error: "Недостаточно энергии для сбора нектара!" });
    }

    user.energy -= requiredEnergy;
    const coinsEarned = clicksCount * user.multitapLevel;
    user.balance += coinsEarned;
    user.totalEarned += coinsEarned; 

    // Расчет эволюционного уровня пчелы на основе массива BACKEND_LEVELS
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
// 4. УЛУЧШЕНИЕ КАРТОЧЕК В РАЗДЕЛЕ «РАЗВИТИЕ СОТ» (МАЙНИНГ БИЗНЕС-СОТ)
app.post('/api/user/buy-card', async (req, res) => {
  try {
    const { telegramId, cardId } = req.body;
    const cardConfig = UPGRADE_CARDS_CONFIG[cardId];
    if (!cardConfig) return res.status(400).json({ success: false, error: "Такого улучшения не существует в улье" });

    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ success: false, error: "Пользователь не найден" });

    user.calculateOfflineProgress();

    const userCardIndex = user.purchasedCards.findIndex(c => c.cardId === cardId);
    const currentLevel = userCardIndex !== -1 ? user.purchasedCards[userCardIndex].level : 0;
    const currentPrice = Math.floor(cardConfig.basePrice * Math.pow(1.5, currentLevel));

    if (user.balance < currentPrice) {
      return res.status(400).json({ success: false, error: "В улье недостаточно меда для покупки!" });
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

app.get('/', (req, res) => res.send('API пчелиного кликера Tap Game стабильно работает онлайн! 🐝'));

// =========================================================================
// РАЗДЕЛ 5: ЗАПУСК TELEGRAM-БОТА С ПЧЕЛИНОЙ РЕФЕРАЛЬНОЙ СИСТЕМОЙ
// =========================================================================
if (bot) {
  bot.start(async (ctx) => {
    try {
      const telegramId = ctx.from.id.toString();
      const username = ctx.from.username || ctx.from.first_name || "Пчёлка";
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
          const inviter = await User.findOne({ telegramId: referredById });
          if (inviter) {
            inviter.balance += 5000;
            inviter.totalEarned += 5000;
            inviter.referrals.push({ userId: telegramId, username: username, bonusClaimed: true });
            await inviter.save();
          }
        }
      }

      ctx.reply(`Привет, ${username}! Добро пожаловать в улей Tap Game! 🐝\nНажми на кнопку ниже, чтобы начать собирать нектар и строить соты:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Развивать Улей! 🍯", web_app: { url: process.env.FRONTEND_URL || "https://ds3343366-hue.github.io/clicker-frontend/" } }]
          ]
        }
      });
    } catch (err) {
      console.error("Ошибка внутри обработчика bot.start:", err);
    }
  });
}

// =========================================================================
// РАЗДЕЛ 6: ИСПРАВЛЕНО: БЕЗОПАСНЫЙ СИНХРОННЫЙ ЗАПУСК БАЗЫ MONGOOSE ИЗ ENV
// =========================================================================
const fallbackMongo = 'mongodb://127.0.0.1:27017/tap game';
const mongoUri = process.env.MONGO_URI || fallbackMongo;

mongoose.connect(mongoUri)
  .then(() => {
    console.log('✅ База данных MongoDB Atlas успешно подключена');
    
    app.listen(PORT, () => {
      console.log(`🚀 Сервер Express начал слушать порт ${PORT}`);
      
      if (bot && process.env.TELEGRAM_BOT_TOKEN) {
        bot.launch()
          .then(() => console.log('🤖 Робот Telegraf успешно запущен в фоновом режиме Polling'))
          .catch((botError) => console.error('❌ Ошибка при старте самого бота:', botError));
      }
    });
  })
  .catch((err) => {
    console.error('❌ Сбой при подключении к MongoDB:', err);
  });

process.on('unhandledRejection', (reason) => console.error('❌ Ошибка Rejection:', reason));
process.on('uncaughtException', (err) => console.error('❌ Критическая ошибка Exception:', err));

