import asyncio
import logging
from aiogram import Bot, Dispatcher, html, F
from aiogram.filters import CommandStart
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo

# 1. Укажите ваш токен от @BotFather
TOKEN = "8859492709:AAEy4ISPMs65OJJVeHkLfl94KRMrLlgDRmk"

# 2. Укажите URL-адрес, куда вы загрузили ваш index.html (например, с GitHub Pages)
# Обратите внимание, что ссылка обязательно должна начинаться с https://
WEBAPP_URL = "https://ds3343366-hue.github.io/aaaclickerbackend/"

# Настройка логирования для отслеживания ошибок
logging.basicConfig(level=logging.INFO)

bot = Bot(token=TOKEN)
dp = Dispatcher()

@dp.message(CommandStart())
async def cmd_start(message: Message):
    user_name = message.from_user.first_name
    user_id = message.from_user.id
    
    # Извлекаем реферальный код, если пользователь перешел по ссылке друга
    # Ссылка формата: t.me/bot?startapp=12345
    args = message.text.split()
    ref_parent = args[1] if len(args) > 1 else None
    
    welcome_text = (
        f"Привет, {html.bold(user_name)}! 🚀\n\n"
        f"Добро пожаловать в {html.code('Cyber Miner')} — кликер нового поколения.\n"
        f"Улучшай свои видеокарты, добывай коины и зови друзей!"
    )
    
    if ref_parent:
        welcome_text += f"\n\n🎁 Вы зашли по реферальной ссылке игрока ID: {ref_parent}!"

    # Создаем кнопку запуска Mini App
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(
                text="🎮 Играть в Cyber Miner", 
                web_app=WebAppInfo(url=WEBAPP_URL)
            )
        ],
        [
            InlineKeyboardButton(
                text="📢 Наш Канал", 
                url="https://t.me" # Замените на ваш канал проекта
            )
        ]
    ])
    
    await message.answer(welcome_text, reply_markup=kb, parse_mode="HTML")

async def main():
    print("Бот успешно запущен и готов к работе!")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
