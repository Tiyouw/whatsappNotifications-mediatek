"use client";

import dayjs from "dayjs";

interface ReminderCardProps {
  task: string;
  deadline: string;
  status: string;
  source: "auto" | "manual";
  notes: string;
  approval: string;
}

function getUrgency(deadline: string): {
  label: string;
  color: string;
  borderColor: string;
  bgColor: string;
} {
  const today = dayjs().startOf("day");
  const deadlineDate = dayjs(deadline).startOf("day");
  const daysLeft = deadlineDate.diff(today, "day");

  if (daysLeft < 0) {
    return {
      label: `${Math.abs(daysLeft)} day${Math.abs(daysLeft) !== 1 ? "s" : ""} overdue`,
      color: "text-red-700",
      borderColor: "border-l-red-500",
      bgColor: "bg-red-50",
    };
  }
  if (daysLeft === 0) {
    return {
      label: "Due today",
      color: "text-orange-700",
      borderColor: "border-l-orange-500",
      bgColor: "bg-orange-50",
    };
  }
  if (daysLeft <= 3) {
    return {
      label: `${daysLeft} day${daysLeft !== 1 ? "s" : ""} left`,
      color: "text-yellow-700",
      borderColor: "border-l-yellow-500",
      bgColor: "bg-yellow-50",
    };
  }
  return {
    label: `${daysLeft} days left`,
    color: "text-green-700",
    borderColor: "border-l-green-500",
    bgColor: "bg-green-50",
  };
}

export default function ReminderCard({
  task,
  deadline,
  status,
  source,
  notes,
  approval,
}: ReminderCardProps) {
  const urgency = getUrgency(deadline);
  const isDone = status === "done";

  return (
    <div
      className={`bg-white rounded-lg shadow-sm border-l-4 ${
        isDone ? "border-l-slate-300 opacity-70" : urgency.borderColor
      } p-4 space-y-2`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          className={`font-medium text-sm sm:text-base ${
            isDone ? "line-through text-slate-500" : "text-slate-900"
          }`}
        >
          {task}
        </h3>
        <div className="flex gap-1.5 flex-shrink-0">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              status === "active"
                ? "bg-blue-100 text-blue-800"
                : status === "done"
                  ? "bg-slate-100 text-slate-600"
                  : "bg-slate-100 text-slate-500"
            }`}
          >
            {status}
          </span>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              source === "auto"
                ? "bg-purple-100 text-purple-700"
                : "bg-teal-100 text-teal-700"
            }`}
          >
            {source}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-500">
          {dayjs(deadline).format("DD MMM YYYY")}
        </span>
        <span
          className={`font-medium text-xs px-2 py-0.5 rounded ${
            isDone ? "text-slate-400" : `${urgency.color} ${urgency.bgColor}`
          }`}
        >
          {isDone ? "Completed" : urgency.label}
        </span>
      </div>

      {notes && (
        <p className="text-xs text-slate-500 border-t border-slate-100 pt-2">
          {notes}
        </p>
      )}

      {approval && (
        <p className="text-xs text-slate-400">Approved by: {approval}</p>
      )}
    </div>
  );
}
