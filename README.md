# Favored

Polymarket Scanner + Bulk Trader + Portfolio Manager.

A private single-user application for discovering high-probability Polymarket opportunities, building bulk order baskets, and managing positions.

## Features

- **Market Scanning**: Automated discovery of markets with 65-90% implied probability
- **Scoring Algorithm**: 4-component scoring (probability, spread, liquidity, time-to-resolution)
- **Basket Building**: Group orders with category exposure limits and slippage guards
- **Portfolio Tracking**: Real-time position monitoring with P&L calculation
- **Risk Controls**: Kill switch, exposure caps, and slippage guards
- **Audit Logging**: Full trail of scans, orders, and system events

## Architecture

```
favored/
├── apps/
│   ├── web/          # Next.js 15 dashboard
│   └── worker/       # Background job service
├── packages/
│   └── shared/       # Polymarket clients, scoring, risk controls
└── prisma/           # Database schema
```

## Quick Start

1. Copy environment file:
   ```bash
   cp .env.example .env
   ```

2. Start services:
   ```bash
   docker-compose up -d
   ```

3. Open http://localhost:3000

## MVP Progression

- **MVP0 (Shadow Mode)**: Market scanning, scoring, shadow trading (no real orders)
- **MVP1 (Assisted)**: Real order placement with manual approval
- **MVP2 (Automation)**: Automated basket building and exit logic

## Tech Stack

- Next.js 15 + React 19 + TypeScript
- Prisma + PostgreSQL
- shadcn/ui components
- Turborepo monorepo
- Docker + Coolify deployment
