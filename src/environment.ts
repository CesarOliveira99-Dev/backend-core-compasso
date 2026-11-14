import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Local configuration stays outside source control. Hosting variables take precedence.
try {
  loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
    throw new Error('Não foi possível carregar a configuração local do backend.');
}
