#!/usr/bin/env bun
/**
 * Scraped Jobs Sync — push daily graduate/campus job feed to jr-academy backend.
 *
 * 由 graduate-jobs routine 每天产 src/data/scraped-jobs/{DATE}.json
 * 然后 GH Actions (.github/workflows/scraped-jobs-sync.yml) 触发本脚本。
 *
 * 不绑 bootcamp、不分 tier、不调 AI 分析。纯把 5 个校招岗位 POST 到
 * /admin-cms/jobs/scraped-jobs/bulk 让后端 upsert 进 Job 集合（isAutoScraped=true）。
 *
 * Usage:
 *   bun run scripts/sync-scraped-jobs.ts                # sync today's file
 *   bun run scripts/sync-scraped-jobs.ts <date>         # sync specific date
 *
 * Env:
 *   JR_SERVICE_API_KEY  (required) — jrak_xxx for /admin-cms/* auth
 *   JR_API              (optional) — defaults to https://api.jiangren.com.au
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.JR_API || 'https://api.jiangren.com.au';
const TOKEN =
	process.env.JR_SERVICE_API_KEY ||
	process.env.JR_ADMIN_TOKEN ||
	process.env.ADMIN_TOKEN ||
	'';

if (!TOKEN) {
	console.error('::error::JR_SERVICE_API_KEY env var is required.');
	process.exit(1);
}
console.log(`▶ token=${TOKEN.slice(0, 8)}... api=${API}`);

interface ScrapedJob {
	title: string;
	company: string;
	location?: string;
	market?: 'AU' | 'CN';
	category?: string;
	level?: 'Graduate';
	postedAt?: string;
	applyUrl: string;
	snippet?: string;
	description?: string;
}

interface ScrapedJobsFile {
	date: string;
	generatedAt?: string;
	jobScope?: string;
	sources?: string[];
	jobs: ScrapedJob[];
}

const VALID_MARKETS = new Set(['AU', 'CN']);
const VALID_CATEGORIES = new Set([
	'AI Engineer',
	'ML Engineer',
	'MLOps / AI Infra',
	'AI Product / PM',
	'Business Analyst',
	'Data Scientist',
	'Data Engineer'
]);

function validateGraduateJobsFile(file: ScrapedJobsFile, filePath: string) {
	if (!Array.isArray(file.jobs) || file.jobs.length !== 5) {
		throw new Error(`${filePath} must contain exactly 5 jobs, got ${file.jobs?.length ?? 0}`);
	}

	file.jobs.forEach((job, index) => {
		const label = `jobs[${index}]`;
		if (!job.title || !job.company || !job.location || !job.applyUrl) {
			throw new Error(`${label} requires title, company, location, applyUrl`);
		}
		if (!job.market || !VALID_MARKETS.has(job.market)) {
			throw new Error(`${label} invalid market "${job.market}"`);
		}
		if (!job.category || !VALID_CATEGORIES.has(job.category)) {
			throw new Error(`${label} invalid category "${job.category}"`);
		}
		if (job.level !== 'Graduate') {
			throw new Error(`${label} level must be Graduate`);
		}
		if (job.applyUrl.includes('linkedin.com')) {
			throw new Error(`${label} LinkedIn URL forbidden`);
		}
	});
}

function aestDate(): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Australia/Sydney',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	})
		.format(new Date())
		.replace(/\//g, '-');
}

async function postJSON(endpoint: string, body: unknown): Promise<{ status: number; data: any }> {
	const res = await fetch(`${API}${endpoint}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${TOKEN}`
		},
		body: JSON.stringify(body)
	});
	const text = await res.text();
	let data: any = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { raw: text };
	}
	return { status: res.status, data };
}

async function main() {
	const date = process.argv[2] || aestDate();
	const filePath = path.resolve(ROOT, 'src/data/scraped-jobs', `${date}.json`);

	if (!fs.existsSync(filePath)) {
		console.log(`No file at ${filePath}, exit 0`);
		process.exit(0);
	}

	const raw = fs.readFileSync(filePath, 'utf-8');
	const file = JSON.parse(raw) as ScrapedJobsFile;

	if (!Array.isArray(file.jobs) || file.jobs.length === 0) {
		console.error('::error::jobs[] is required and must contain exactly 5 items.');
		process.exit(1);
	}
	validateGraduateJobsFile(file, filePath);

	// Pre-filter: drop any LinkedIn URLs (defense in depth — routine should already filter)
	const cleanJobs = file.jobs.filter(j => {
		if (!j.applyUrl || j.applyUrl.includes('linkedin.com')) {
			console.log(`  ⏭️  skip (LinkedIn or no url): ${j.title} @ ${j.company}`);
			return false;
		}
		return true;
	});

	console.log(`▶ Syncing ${cleanJobs.length} jobs from ${date} to ${API}`);

	// POST in chunks of 25 to stay under endpoint cap (50)
	const CHUNK = 25;
	let totalCreated = 0;
	let totalUpdated = 0;
	let totalSuperseded = 0;
	let totalCompanies = 0;
	let allOk = true;

	for (let i = 0; i < cleanJobs.length; i += CHUNK) {
		const batch = cleanJobs.slice(i, i + CHUNK);
		console.log(`  chunk ${i / CHUNK + 1}: ${batch.length} jobs`);

		const resp = await postJSON('/admin-cms/jobs/scraped-jobs/bulk', {
			date: file.date,
			jobs: batch,
			supersedeOlder: i === 0 // only on first chunk
		});

		if (resp.status === 200 || resp.status === 201) {
			const d = resp.data?.data || {};
			totalCreated += d.created || 0;
			totalUpdated += d.updated || 0;
			totalSuperseded += d.superseded || 0;
			totalCompanies += d.companiesCreated || 0;
			console.log(
				`    ✅ created=${d.created} updated=${d.updated} superseded=${d.superseded}`
			);
		} else {
			console.error(`    ❌ HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 500)}`);
			allOk = false;
		}
	}

	console.log(`\n=== Sync complete ===`);
	console.log(
		`Total: created=${totalCreated} updated=${totalUpdated} superseded=${totalSuperseded} companies=${totalCompanies}`
	);

	if (!allOk) {
		console.error('❌ Some chunks failed');
		process.exit(1);
	}
}

main().catch(err => {
	console.error('Unhandled error:', err);
	process.exit(1);
});
