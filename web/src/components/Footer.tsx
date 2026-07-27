/**
 * Footer. The attribution is not decoration — the StatsBomb Public Data User
 * Agreement (clause 1.4) requires the logo as well as the text, and CONTRACT §9
 * pins the wording exactly. The logo file is their own lockup from the
 * open-data repository, unmodified.
 *
 * The query-time readout is here too: analysts like knowing what a search cost,
 * and it is the only honest way to make the "< 300 ms" claim checkable.
 */
import { publicUrl } from '../duck/data';

const ATTRIBUTION =
  'Data provided by StatsBomb. Halfspace is built on StatsBomb Open Data. Used under the ' +
  'StatsBomb Public Data User Agreement for research and non-commercial analysis. StatsBomb is ' +
  'not affiliated with this project and does not endorse any analysis presented here.';

interface Props {
  lastQueryMs: number | null;
  bootMs: number | null;
  datasetVersion?: string;
  builtAt?: string;
}

export function Footer({ lastQueryMs, bootMs, datasetVersion, builtAt }: Props) {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <a
          className="footer-logo"
          href="https://github.com/statsbomb/open-data"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="StatsBomb Open Data"
        >
          <img
            src={publicUrl('statsbomb-lockup.png')}
            alt="StatsBomb"
            loading="lazy"
            decoding="async"
            width={162}
            height={26}
          />
        </a>

        <p className="footer-text">
          {ATTRIBUTION}{' '}
          <a href="https://github.com/statsbomb/open-data" target="_blank" rel="noopener noreferrer">
            StatsBomb Open Data
          </a>{' '}
          ·{' '}
          <a
            href="https://github.com/danfirsten/halfspace"
            target="_blank"
            rel="noopener noreferrer"
          >
            Halfspace source on GitHub
          </a>
        </p>

        <div className="footer-meta">
          {lastQueryMs !== null ? (
            <span>
              last query <span className="num">{lastQueryMs.toFixed(0)} ms</span>
            </span>
          ) : null}
          {bootMs !== null ? (
            <span>
              index ready in <span className="num">{(bootMs / 1000).toFixed(2)} s</span>
            </span>
          ) : null}
          {datasetVersion ? (
            <span>
              dataset <span className="num">v{datasetVersion}</span>
            </span>
          ) : null}
          {builtAt ? <span>built {builtAt.slice(0, 10)}</span> : null}
        </div>
      </div>
    </footer>
  );
}
