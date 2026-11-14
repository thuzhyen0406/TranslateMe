// Đóng gói mã Lambda cho stack api: services/proxy (proxy, worker, 4 hàm PREWARM) và services/api (các hàm còn lại).
// Gói = dist của tsc (rootDir ../.. nên có cả libs/common) + node_modules production + package.json {"type":"module"}
// ở gốc, để handler dạng services/<pkg>/<file>.handler chạy được trên nodejs22.x (ESM).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const LAMBDA_PACKAGES = [
  { name: 'proxy', dir: 'services/proxy' },
  { name: 'api', dir: 'services/api' },
] as const;
export type LambdaPackageName = (typeof LAMBDA_PACKAGES)[number]['name'];

export const repoRoot = resolve(__dirname, '..', '..');

/** Không đưa test và mã console (api biên dịch kèm để test hợp đồng 4.6) vào gói Lambda. */
export function shouldShip(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  if (parts.includes('test') || parts.includes('node_modules')) return false;
  if (parts[0] === 'console') return false;
  if (parts.includes('experiments')) return false;
  return !/\.(map|d\.ts)$/.test(relPath);
}

export function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} lỗi (thư mục ${relative(repoRoot, cwd) || '.'})`);
}

function zipDir(dir: string, out: string): void {
  rmSync(out, { force: true });
  const z = spawnSync('zip', ['-qr', '-X', out, '.'], { cwd: dir, stdio: 'inherit' });
  if (z.status === 0) return;
  // Không có lệnh zip: dùng python3
  const py = spawnSync('python3', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1][:-4], "zip", sys.argv[2])', out, dir], { stdio: 'inherit' });
  if (py.status !== 0) throw new Error('Cần lệnh zip hoặc python3 để đóng gói Lambda');
}

export const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Khóa S3 theo nội dung: gói không đổi thì khóa không đổi, CloudFormation không cập nhật Lambda thừa. */
export const codeKey = (name: string, sha: string) => `lambda/${name}-${sha.slice(0, 16)}.zip`;

export interface BuiltPackage { name: LambdaPackageName; zip: string; key: string; bytes: number }

export function buildLambdaPackage(name: LambdaPackageName, buildDir: string, o: { install?: boolean } = {}): BuiltPackage {
  const pkg = LAMBDA_PACKAGES.find((p) => p.name === name)!;
  const src = join(repoRoot, pkg.dir);
  if (o.install !== false) {
    run('npm', ['ci', '--no-audit', '--no-fund'], join(repoRoot, 'libs', 'common'));
    run('npm', ['ci', '--no-audit', '--no-fund'], src);
  }
  run('npm', ['run', 'build'], src);
  const dist = join(src, 'dist');
  if (!existsSync(dist)) throw new Error(`Không thấy ${pkg.dir}/dist sau khi build`);

  const stage = join(buildDir, `lambda-${name}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(dist, stage, { recursive: true, filter: (p) => p === dist || shouldShip(relative(dist, p).split(sep).join('/')) });
  // Chép nguyên package.json + lock (npm ci báo lệch nếu sửa); "type":"module" sẵn có cho handler ESM.
  const manifest = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  if (manifest.type !== 'module') throw new Error(`${pkg.dir}/package.json phải có "type": "module"`);
  cpSync(join(src, 'package.json'), join(stage, 'package.json'));
  cpSync(join(src, 'package-lock.json'), join(stage, 'package-lock.json'));
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
  rmSync(join(stage, 'package-lock.json'), { force: true });

  const zip = join(buildDir, `lambda-${name}.zip`);
  zipDir(stage, zip);
  const bytes = readFileSync(zip).length;
  return { name, zip, key: codeKey(name, sha256File(zip)), bytes };
}
