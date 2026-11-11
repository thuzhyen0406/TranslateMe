// Nạp file stage-specific trước khi bất kỳ helper nào đọc TM_*.
import { config as loadDotEnv } from 'dotenv';
import { resolve } from 'node:path';

const file = process.env.TM_ENV_FILE ?? `.env.${process.env.TM_STAGE ?? 'dev'}`;
loadDotEnv({ path: resolve(process.cwd(), file), override: false });
