import { useCallback, useEffect, useState } from 'react';
import { fetchHealth, type HealthCheck } from './api';

const POLL_MS = 3000;

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h} 小时 ${m} 分 ${s} 秒`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`dot ${ok ? 'ok' : 'bad'}`} aria-hidden="true" />;
}

function Card({ title, check }: { title: string; check: HealthCheck | null }) {
  if (!check) {
    return (
      <div className="card">
        <h3>{title}</h3>
        <p className="muted">加载中…</p>
      </div>
    );
  }
  const ok = check.ok && check.body?.status === 'ok';
  return (
    <div className={`card ${ok ? 'card-ok' : 'card-bad'}`}>
      <h3>{title}</h3>
      {check.body ? (
        <p className={ok ? 'ok-text' : 'bad-text'}>
          <Dot ok={ok} /> {ok ? '正常' : `异常（HTTP ${check.httpStatus}，状态 ${check.body.status}）`}
        </p>
      ) : (
        <p className="bad-text">
          <Dot ok={false} /> 无法连接内核{check.error ? `：${check.error}` : `（HTTP ${check.httpStatus || '—'}）`}
        </p>
      )}
    </div>
  );
}

export function App() {
  const [live, setLive] = useState<HealthCheck | null>(null);
  const [ready, setReady] = useState<HealthCheck | null>(null);

  const refresh = useCallback(async () => {
    setLive(await fetchHealth('live'));
    setReady(await fetchHealth('ready'));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const body = ready?.body ?? live?.body ?? null;

  return (
    <main className="page">
      <header>
        <h1>Orch 工业设备控制与编排平台</h1>
        <p className="subtitle">运行状态 · 每 {POLL_MS / 1000} 秒自动刷新</p>
      </header>

      <section className="cards">
        <Card title="存活探针 GET /health/live" check={live} />
        <Card title="就绪探针 GET /health/ready" check={ready} />
      </section>

      {body && (
        <section className="detail">
          <h2>内核</h2>
          <dl className="grid">
            <dt>版本</dt>
            <dd>{body.version}</dd>
            <dt>运行时长</dt>
            <dd>{formatUptime(body.uptimeSec)}</dd>
            <dt>存储模式</dt>
            <dd>{body.storage.mode}</dd>
            <dt>存储状态</dt>
            <dd className={body.storage.ok ? 'ok-text' : 'bad-text'}>
              <Dot ok={body.storage.ok} /> {body.storage.ok ? '正常' : '不可用'}
            </dd>
          </dl>

          <h2>
            插件（{body.plugins.length}）
          </h2>
          {body.plugins.length === 0 ? (
            <p className="muted">暂无已加载插件 — 驱动插件宿主随后续工单（#3）接入。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>插件</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {body.plugins.map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td>{p.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <footer className="muted">Apache-2.0 · walking skeleton（工单 #2）</footer>
    </main>
  );
}
