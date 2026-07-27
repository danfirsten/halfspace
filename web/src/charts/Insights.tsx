/**
 * The Insights section.
 *
 * The specs are generated offline by `ingest/viz.py` with Altair, straight from
 * phases.parquet — every value in every chart was aggregated by DuckDB against
 * the real dataset and baked into the spec. The browser does no arithmetic, so
 * there is nothing here that can quietly become a fabricated number.
 *
 * vega-embed is a large dependency, so it is code-split and only imported when
 * this section actually scrolls into view.
 */
import { useEffect, useRef, useState } from 'react';
import { publicUrl } from '../duck/data';

interface ChartMeta {
  file: string;
  title: string;
  caption: string;
}

interface ChartIndex {
  phases: number;
  charts: ChartMeta[];
}

const chartUrl = (path: string) => publicUrl(`charts/${path}`);

export function Insights() {
  const [index, setIndex] = useState<ChartIndex | null>(null);
  const [visible, setVisible] = useState(false);
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    fetch(chartUrl('index.json'))
      .then((r) => r.json())
      .then((data: ChartIndex) => {
        if (!cancelled) setIndex(data);
      })
      .catch(() => {
        /* charts are supplementary; the app works without them */
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  return (
    <section className="insights shell" ref={hostRef} aria-labelledby="insights-heading">
      <div className="section-head">
        <h2 id="insights-heading">Insights</h2>
        <p>
          Generated offline with Altair from the same parquet the search reads — every value is
          measured, none are estimated.
        </p>
      </div>
      <div className="chart-grid">
        {(index?.charts ?? []).map((chart) => (
          <ChartCard key={chart.file} meta={chart} />
        ))}
        {!index
          ? Array.from({ length: 4 }, (_, i) => (
              <div className="chart-card" key={i}>
                <div className="skeleton-line shimmer" style={{ width: '55%', margin: '2px 0 10px' }} />
                <div className="shimmer" style={{ height: 150, borderRadius: 4 }} />
              </div>
            ))
          : null}
      </div>
    </section>
  );
}

function ChartCard({ meta }: { meta: ChartMeta }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let view: { finalize: () => void } | null = null;

    (async () => {
      const [{ default: embed }, spec] = await Promise.all([
        import('vega-embed'),
        fetch(chartUrl(meta.file)).then((r) => r.json()),
      ]);
      if (disposed || !ref.current) return;
      const result = await embed(ref.current, spec, {
        actions: false,
        renderer: 'canvas',
        tooltip: { theme: 'dark' },
      });
      if (disposed) result.view.finalize();
      else view = result.view;
    })().catch(() => setFailed(true));

    return () => {
      disposed = true;
      view?.finalize();
    };
  }, [meta.file]);

  return (
    <figure className="chart-card" style={{ margin: 0 }}>
      <h3>{meta.title}</h3>
      <p>{meta.caption}</p>
      {failed ? (
        <p style={{ color: '#6d7681' }}>Chart unavailable.</p>
      ) : (
        <div ref={ref} role="img" aria-label={`${meta.title}. ${meta.caption}`} />
      )}
    </figure>
  );
}
