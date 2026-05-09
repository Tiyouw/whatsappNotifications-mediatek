"use client";

interface FilterTabsProps {
  statusFilter: string;
  sourceFilter: string;
  onStatusChange: (status: string) => void;
  onSourceChange: (source: string) => void;
}

export default function FilterTabs({
  statusFilter,
  sourceFilter,
  onStatusChange,
  onSourceChange,
}: FilterTabsProps) {
  const statusOptions = ["all", "active", "done"];
  const sourceOptions = ["all", "auto", "manual"];

  return (
    <div className="space-y-3">
      <div className="flex gap-1 bg-white rounded-lg p-1 shadow-sm">
        {statusOptions.map((option) => (
          <button
            key={option}
            onClick={() => onStatusChange(option)}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
              statusFilter === option
                ? "bg-blue-600 text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            {option.charAt(0).toUpperCase() + option.slice(1)}
          </button>
        ))}
      </div>
      <div className="flex gap-1 bg-white rounded-lg p-1 shadow-sm">
        {sourceOptions.map((option) => (
          <button
            key={option}
            onClick={() => onSourceChange(option)}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
              sourceFilter === option
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            {option.charAt(0).toUpperCase() + option.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}
