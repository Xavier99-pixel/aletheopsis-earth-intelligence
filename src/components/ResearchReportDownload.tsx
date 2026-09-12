import { Download, FileCode2, FileText, LoaderCircle } from "lucide-react";
import { useState } from "react";
import {
  downloadResearchReport,
  type ResearchReportDownload as ResearchReportDownloadResult,
  type ResearchReportFormat,
  type ResearchReportInput,
} from "../lib/researchReport";

type ResearchReportDownloadProps = {
  input: ResearchReportInput;
  /** Disable until a completed investigation is available. */
  disabled?: boolean;
  className?: string;
  onDownloaded?: (result: ResearchReportDownloadResult) => void;
  onError?: (error: Error) => void;
};

const FORMAT_LABELS: Record<ResearchReportFormat, string> = {
  html: "Printable report (.html)",
  markdown: "Research notes (.md)",
  json: "Structured data (.json)",
};

function FormatIcon({ format }: { format: ResearchReportFormat }) {
  return format === "json" ? <FileCode2 size={15} /> : <FileText size={15} />;
}

/**
 * Small, framework-native export control. It does not persist data or send the
 * report to a third party; the selected report is built and downloaded locally.
 */
export function ResearchReportDownload({
  input,
  disabled = false,
  className,
  onDownloaded,
  onError,
}: ResearchReportDownloadProps) {
  const [format, setFormat] = useState<ResearchReportFormat>("html");
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const unavailable = disabled || !input.request.question.trim();

  function handleDownload() {
    if (unavailable || downloading) return;
    setDownloading(true);
    setMessage(null);
    try {
      const result = downloadResearchReport(input, format);
      setMessage(`Downloaded ${result.filename}`);
      onDownloaded?.(result);
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("Unable to download the research report.");
      setMessage(error.message);
      onError?.(error);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className={["research-report-download", className].filter(Boolean).join(" ")}>
      <label className="research-report-download__format">
        <span className="sr-only">Report format</span>
        <FormatIcon format={format} />
        <select
          aria-label="Research report format"
          value={format}
          disabled={unavailable || downloading}
          onChange={(event) => setFormat(event.target.value as ResearchReportFormat)}
        >
          {Object.entries(FORMAT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>
      <button
        className="research-report-download__button"
        type="button"
        disabled={unavailable || downloading}
        onClick={handleDownload}
      >
        {downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
        {downloading ? "Preparing report" : "Download report"}
      </button>
      <p className="research-report-download__notice" aria-live="polite">
        {message ?? "Exports question, calculations, evidence, timeline context, methods, caveats, and linked sources."}
      </p>
    </div>
  );
}
