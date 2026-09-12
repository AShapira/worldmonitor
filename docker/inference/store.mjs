const PREFIX = 'wm:inference:v1:';
export class RedisStore {
  constructor(url, token, fetcher = fetch) {
    if (!url || !token) throw new Error('Inference Redis credentials are required');
    this.url = url; this.token = token; this.fetch = fetcher;
  }
  async command(...args) {
    const response = await this.fetch(this.url, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-inference/1.0' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Inference state storage unavailable');
    const data = await response.json();
    if (data.error) throw new Error('Inference state storage rejected the operation');
    return data.result;
  }
  async get(key) {
    const value = await this.command('GET', PREFIX + key);
    return value ? JSON.parse(value) : null;
  }
  async put(key, value, ttl) {
    await this.command('SET', PREFIX + key, JSON.stringify(value), ...(ttl ? ['EX', ttl] : []));
  }
  async jobs() {
    const jobs = []; let cursor = '0';
    do {
      const page = await this.command('SCAN', cursor, 'MATCH', PREFIX + 'job:*', 'COUNT', '100');
      cursor = String(page[0]);
      for (const key of page[1]) {
        const raw = await this.command('GET', key);
        if (raw) jobs.push(JSON.parse(raw));
      }
    } while (cursor !== '0');
    return jobs.sort((a, b) => b.createdAt - a.createdAt);
  }
}
