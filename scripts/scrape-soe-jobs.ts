#!/usr/bin/env bun
/**
 * SOE Jobs Scraper — 国企/央企 IT/AI/Data 岗位采集(/china-jobs 精选橱窗用)
 *
 * 与 daily-jobs(WebSearch 抓 5 条校招)不同:本脚本走开放 JSON API 确定性采集。
 *   - 国聘网 iguopin: POST gp-api.iguopin.com/api/jobs/v1/list(匿名 ~200 条,字段全)
 *   - 教育部 ncss:   GET ncss.cn/.../jobslist/ajax(匿名 ~20 条,带 recProperty 企业性质)
 * 注:两源匿名都限量(见 docs/prd/CHINA_JOBS_P0_DATA_PROBE.md),定位"精选橱窗"非全量。
 *
 * 只保留 IT/AI/Data 相关岗位(复用 scraped-jobs 7 类 taxonomy),其余丢弃。
 * 输出到 src/data/soe-jobs/{DATE}.json(独立目录,不污染 daily-jobs 的 scraped-jobs/)。
 *
 * Usage: bun run scripts/scrape-soe-jobs.ts
 * 合规:只读公开免登录接口、低频、标注来源、applyUrl 指向官方原页;不绕签名/登录墙。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— scraped-jobs 7 类 taxonomy(关键词分类,只留 IT/AI/Data)——
const CATEGORY_RULES: { category: string; kw: RegExp }[] = [
	{ category: 'AI Engineer', kw: /(AI\s*工程|AI\s*应用|大模型|生成式|AIGC|LLM|人工智能.*(工程|开发|算法)|AI\s*Engineer)/i },
	{ category: 'ML Engineer', kw: /(机器学习|深度学习|算法工程|算法专家|Machine\s*Learning|ML\s*Engineer|NLP|计算机视觉|CV\s*算法)/i },
	{ category: 'MLOps / AI Infra', kw: /(MLOps|AI\s*平台|模型.*(部署|推理|训练平台)|向量|RAG|AI\s*Infra|机器学习平台)/i },
	{ category: 'AI Product / PM', kw: /(AI\s*产品|智能.*产品经理|GenAI\s*Product|大模型.*产品)/i },
	{ category: 'Data Scientist', kw: /(数据科学|Data\s*Scientist|数据挖掘|量化研究|统计建模)/i },
	{ category: 'Data Engineer', kw: /(数据工程|Data\s*Engineer|大数据|数据开发|数据仓库|数仓|ETL|实时计算|数据平台)/i },
	{ category: 'Business Analyst', kw: /(业务分析|Business\s*Analyst|数据分析师|BI\s*分析|经营分析)/i },
];

function classifyCategory(title: string): string | null {
	for (const r of CATEGORY_RULES) if (r.kw.test(title)) return r.category;
	return null; // 非 IT/AI/Data → 丢弃
}

function classifyLevel(experienceCn?: string, isGraduates?: boolean, title = ''): string {
	if (isGraduates || /应届|无经验|无要求/.test(experienceCn || '')) return 'Graduate';
	if (/(总监|负责人|专家|经理|主管|资深|高级|首席|架构师|leader|lead|principal|staff|senior)/i.test(title)) return 'Senior';
	if (/1-3\s*年|1-2\s*年|1～3/.test(experienceCn || '')) return 'Junior';
	if (/5\s*年|5年以上|5\+|十年|10\s*年/.test(experienceCn || '')) return 'Senior';
	if (/3-5\s*年|3～5/.test(experienceCn || '')) return 'Mid';
	return 'Mid';
}

function aestDate(): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
	}).format(new Date()).replace(/\//g, '-');
}

interface SoeJob {
	title: string;
	company: string;
	location: string;
	market: 'CN';
	category: string;
	level: string;
	postedAt: string;
	deadline?: string;
	applyUrl: string;
	snippet: string;
	description: string;
	sourcePlatform: 'iguopin' | 'ncss';
	companyType?: string; // ncss recProperty 映射;iguopin 未知留空(不臆测)
}

async function fetchIguopin(maxPages = 20): Promise<SoeJob[]> {
	const out: SoeJob[] = [];
	for (let page = 1; page <= maxPages; page++) {
		let json: any;
		try {
			const res = await fetch('https://gp-api.iguopin.com/api/jobs/v1/list', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Origin: 'https://www.iguopin.com',
					Referer: 'https://www.iguopin.com/',
					'User-Agent': 'Mozilla/5.0',
				},
				body: JSON.stringify({ search: { page, page_size: 10, keyword: '' } }),
			});
			json = await res.json();
		} catch (e) {
			console.log(`  iguopin page ${page} 失败: ${String(e).slice(0, 80)}`);
			break;
		}
		const list: any[] = json?.data?.list || [];
		if (!list.length) break;
		for (const j of list) {
			const title = String(j.job_name || '').trim();
			const category = classifyCategory(title);
			if (!category) continue; // 只留 IT/AI/Data
			const district = (j.district_list || [])[0]?.area_cn || '';
			const contents = String(j.contents || '').replace(/\s+/g, ' ').trim();
			out.push({
				title,
				company: String(j.company_name || '').trim(),
				location: district,
				market: 'CN',
				category,
				level: classifyLevel(j.experience_cn, j.is_graduates, title),
				postedAt: (j.start_time || '').slice(0, 10),
				deadline: (j.end_time || '').slice(0, 10) || undefined,
				applyUrl: `https://www.iguopin.com/job/detail?id=${j.job_id}`,
				snippet: contents.slice(0, 300),
				description: contents,
				sourcePlatform: 'iguopin',
			});
		}
		await new Promise(r => setTimeout(r, 400)); // 低频,礼貌间隔
	}
	return out;
}

async function fetchNcss(): Promise<SoeJob[]> {
	const out: SoeJob[] = [];
	try {
		const res = await fetch('https://www.ncss.cn/student/jobs/jobslist/ajax/?offset=1&limit=20', {
			headers: {
				'X-Requested-With': 'XMLHttpRequest',
				Referer: 'https://www.ncss.cn/student/jobs/index.html',
				'User-Agent': 'Mozilla/5.0',
			},
		});
		const json: any = await res.json();
		const list: any[] = json?.data?.list || [];
		for (const j of list) {
			const title = String(j.jobName || '').trim();
			const category = classifyCategory(title);
			if (!category) continue;
			out.push({
				title,
				company: String(j.recName || '').trim(),
				location: String(j.areaCodeName || '').trim(),
				market: 'CN',
				category,
				level: classifyLevel(undefined, j.recruitType === '1', title),
				postedAt: j.publishDate ? new Date(j.publishDate).toISOString().slice(0, 10) : aestDate(),
				applyUrl: `https://www.ncss.cn/student/jobs/jobsdetail/${j.jobId}`,
				snippet: `${title} · ${j.recName} · ${j.areaCodeName}`,
				description: `${title}（${j.degreeName || ''}，${j.recScale || ''}）`,
				sourcePlatform: 'ncss',
				companyType: j.recProperty === '国有企业' ? 'state-owned' : j.recProperty === '其他' ? undefined : j.recProperty,
			});
		}
	} catch (e) {
		console.log(`  ncss 失败: ${String(e).slice(0, 80)}`);
	}
	return out;
}

function dedupe(jobs: SoeJob[]): SoeJob[] {
	const seen = new Set<string>();
	const out: SoeJob[] = [];
	for (const j of jobs) {
		const k = `${j.company}||${j.title}`;
		if (seen.has(k) || !j.company || !j.title) continue;
		seen.add(k);
		out.push(j);
	}
	return out;
}

async function main() {
	const date = aestDate();
	console.log('▶ 采集国企 IT/AI/Data 岗位 ...');
	const ig = await fetchIguopin();
	console.log(`  iguopin: 命中 IT/AI/Data ${ig.length} 条`);
	const nc = await fetchNcss();
	console.log(`  ncss:    命中 IT/AI/Data ${nc.length} 条`);
	const jobs = dedupe([...ig, ...nc]);
	console.log(`  去重后:  ${jobs.length} 条`);

	const file = {
		date,
		generatedAt: new Date().toISOString(),
		jobScope: '国企/央企 IT·AI·Data 精选(开放 API 匿名采集,限量)',
		sources: ['iguopin.com', 'ncss.cn'],
		jobs,
	};
	const dir = path.resolve(ROOT, 'src/data/soe-jobs');
	fs.mkdirSync(dir, { recursive: true });
	const fp = path.join(dir, `${date}.json`);
	fs.writeFileSync(fp, JSON.stringify(file, null, 2));
	console.log(`✅ 写入 ${fp}`);

	// 分布概览
	const byCat: Record<string, number> = {};
	const byLvl: Record<string, number> = {};
	for (const j of jobs) { byCat[j.category] = (byCat[j.category] || 0) + 1; byLvl[j.level] = (byLvl[j.level] || 0) + 1; }
	console.log('  分类分布:', JSON.stringify(byCat, null, 0));
	console.log('  级别分布:', JSON.stringify(byLvl, null, 0));
}

main().catch(e => { console.error(e); process.exit(1); });
