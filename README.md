# jr-jobs

JR Academy 校招岗位数据仓库 — daily-jobs routine 每天抓 AU + CN 校招机会落盘的地方。

## 数据流

```
每天 07:30 Brisbane (AEST):
  ├─ Routine (claude.ai/code/routines) 跑 daily-jobs 流程
  │   ├─ 抓 AU (Seek/GradConnection/Prosple/careers, NO LinkedIn)
  │   ├─ 抓 CN (牛客/应届生/拉勾/字节腾讯阿里 careers)
  │   └─ 写 src/data/scraped-jobs/{DATE}.json + push 到 main
  ↓ (push 触发)
GitHub Actions: scraped-jobs-sync.yml
  └─ scripts/sync-scraped-jobs.ts
       └─ POST jr-academy /admin-cms/jobs/scraped-jobs/bulk
            └─ 后端 upsert Job (isAutoScraped=true) → 学员侧 /ai-jobs 展示
```

## PRD

完整规则见主 repo: `docs/prd/SCRAPED_JOBS_TAXONOMY.md`

要点：
- **不抓 LinkedIn**（login wall）
- AU + CN 双市场
- Category 7 类（AI Engineer / ML Engineer / MLOps / AI Product / BA / Data Scientist / Data Engineer）
- Level 4 档（Graduate / Junior / Mid / Senior）
- 校招高峰（Aug-Nov 主峰 / Feb-Apr 次峰）总目标 35-55 jobs/天，淡季 25-35

## 目录

```
src/data/scraped-jobs/
  └─ {YYYY-MM-DD}.json   # 每天一个文件，所有 AU+CN job flat 列表

scripts/
  └─ sync-scraped-jobs.ts # GH Actions 调，POST 到 jr-academy

.github/workflows/
  └─ scraped-jobs-sync.yml # paths: src/data/scraped-jobs/**/*.json
```

## Secrets (GH repo settings)

- `JR_SERVICE_API_KEY` — `jrak_xxx` 长期 service key（POST /admin-cms/* 用）
- `API_URL` (可选，默认 `https://api.jiangren.com.au`)
