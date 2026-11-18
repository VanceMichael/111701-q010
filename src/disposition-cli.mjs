import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildDisposition, buildDispositionHistory } from './disposition.mjs';

export async function readJson(path) {
  const text = await readFile(resolve(path), 'utf8');
  return JSON.parse(text);
}

/**
 * 读取召回通知和门店目录，按指定修订（默认最新）生成处置清单。
 * 传入 --all-revisions 时输出全部修订及相邻修订差异。
 */
export async function dispositionFromFiles({
  noticePath,
  catalogPath,
  revision = null,
  allRevisions = false,
}) {
  if (!noticePath || !catalogPath) {
    throw new Error('需要同时提供 --notice 和 --catalog');
  }
  const [notice, catalog] = await Promise.all([readJson(noticePath), readJson(catalogPath)]);
  if (allRevisions) {
    return buildDispositionHistory(notice, catalog);
  }
  return buildDisposition(notice, catalog, { revision });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const options = { allRevisions: args.includes('--all-revisions') };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--notice') {
      options.noticePath = args[(index += 1)];
    } else if (arg === '--catalog') {
      options.catalogPath = args[(index += 1)];
    } else if (arg === '--revision') {
      options.revision = Number(args[(index += 1)]);
    }
  }
  try {
    const result = await dispositionFromFiles(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`生成处置清单失败: ${error.message}`);
    process.exitCode = 1;
  }
}
