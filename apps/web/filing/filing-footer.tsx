import filingIconUrl from "./filing.png";
import "./styles.css";

interface FilingConfig {
  readonly icpFilingNumber: string;
  readonly publicSecurityFilingCode: string;
  readonly publicSecurityFilingNumber: string;
}

declare const __FILING_CONFIG__: FilingConfig | null;

const filingConfig = __FILING_CONFIG__;

export const hasFilingInformation = filingConfig !== null;

export function FilingFooter() {
  if (!filingConfig) return null;

  return (
    <footer aria-label="网站备案信息" className="filing-footer">
      <div className="filing-footer__content">
        <a
          className="filing-footer__public-security"
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${encodeURIComponent(filingConfig.publicSecurityFilingCode)}`}
          rel="noreferrer"
          target="_blank"
        >
          <img alt="" aria-hidden="true" src={filingIconUrl} />
          <span>{filingConfig.publicSecurityFilingNumber}</span>
        </a>
        <a
          className="filing-footer__icp"
          href="https://beian.miit.gov.cn"
          rel="noreferrer"
          target="_blank"
        >
          {filingConfig.icpFilingNumber}
        </a>
      </div>
    </footer>
  );
}
