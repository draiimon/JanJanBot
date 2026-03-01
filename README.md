# JanJan Discord AI Bot

AI Discord bot using Groq (`openai/gpt-oss-120b`) that replies in friendly Tagalog beki-style when mentioned or when you reply to it.

## 1. Requirements

- Node.js 18+ (recommended)
- A Discord bot application and token
- A Groq API key

## 2. Setup

1. Open a terminal in this folder:

   ```bash
   cd "c:/Users/Aloof/Desktop/Andrei/JanJan"
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Environment variables:

   - The `.env` file is already created locally (and is gitignored).
   - If you ever need to recreate it, copy from `.env.example` and fill in:

   ```bash
   DISCORD_TOKEN=your_discord_bot_token_here
   GROQ_API_KEY=your_groq_api_key_here
   ```

## 3. Running the bot (local)

In the same folder:

```bash
npm start
```

If everything is correct, you should see something like:

```text
Logged in as YourBotName#1234
```

## 4. Running from cloud (Docker)

Most cloud hosts (Render, Railway, etc.) support Docker. Basic idea:

1. Build the image locally (optional, pang-test lang):

   ```bash
   cd "c:/Users/Aloof/Desktop/Andrei/JanJan"
   docker build -t janjan-discord-bot .
   ```

2. Sa napili mong cloud provider:

   - I-connect ang repo/folder na ito, o i-push ang Docker image kung yun ang flow.
   - Gamitin ang `Dockerfile` sa root nito bilang build file.
   - I-set ang environment variables sa dashboard ng provider (huwag sa `.env`):
     - `DISCORD_TOKEN`
     - `GROQ_API_KEY`
   - Walang kailangan na HTTP port; background process lang siya na tumatakbo.

3. I-deploy; pag running na, dapat makita mong online na ang bot sa Discord.

## 5. How to use

- Invite the bot to your server with proper message content intent enabled.
- The bot will answer when:
  - You **mention** it in a message (e.g. `@JanJan kamusta ka na teh?`)
  - You **reply** to one of its messages.
- Replies are:
  - Tagalog
  - Beki-style (pang-bading)
  - Friendly and wholesome (no NSFW/offensive content)

Enjoy the chikahan with your AI beki bot! 💅

