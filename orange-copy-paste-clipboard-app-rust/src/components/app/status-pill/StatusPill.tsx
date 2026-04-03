import React from "react";
import "./StatusPill.css";

interface StatusPillProps {
  textCount: number;
  imageCount: number;
  fileCount: number;
  htmlCount: number;
  total: number;
}

const StatusPill: React.FC<StatusPillProps> = ({
  textCount,
  imageCount,
  fileCount,
  htmlCount,
  total,
}) => (
  <div className="status-pill">
    <span className="status-item">
      <span className="status-value">{textCount}</span> text
    </span>
    <span className="status-dot" />
    <span className="status-item">
      <span className="status-value">{htmlCount}</span> rich
    </span>
    <span className="status-dot" />
    <span className="status-item">
      <span className="status-value">{imageCount}</span> img
    </span>
    <span className="status-dot" />
    <span className="status-item">
      <span className="status-value">{fileCount}</span> files
    </span>
    <span className="status-dot" />
    <span className="status-item">
      <span className="status-value">{total}</span> total
    </span>
  </div>
);

export default StatusPill;
