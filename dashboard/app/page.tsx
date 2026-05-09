"use client";

import { useEffect, useState, useCallback } from "react";
import dayjs from "dayjs";
import ReminderCard from "@/components/ReminderCard";
import FilterTabs from "@/components/FilterTabs";

interface Reminder {
  no: string;
  task: string;
  deadline: string;
  target: string;
  notifyDays: number[];
  notes: string;
  status: string;
  source: "auto" | "manual";
  approval: string;
}

export default function Home() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const fetchReminders = useCallback(async () => {
    try {
      const res = await fetch("/api/reminders");
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to fetch reminders");
      }
      const data = await res.json();
      setReminders(data.reminders);
      setLastUpdated(dayjs().format("HH:mm:ss"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReminders();
    const interval = setInterval(fetchReminders, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchReminders]);

  const filtered = reminders
    .filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
      return true;
    })
    .sort((a, b) => {
      const aDate = dayjs(a.deadline);
      const bDate = dayjs(b.deadline);
      return aDate.valueOf() - bDate.valueOf();
    });

  return (
    <main className="min-h-screen p-4 sm:p-6 max-w-2xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Reo Reminders</h1>
        <p className="text-sm text-slate-500 mt-1">
          {lastUpdated
            ? `Last updated: ${lastUpdated}`
            : "Loading..."}
        </p>
      </header>

      <div className="mb-4">
        <FilterTabs
          statusFilter={statusFilter}
          sourceFilter={sourceFilter}
          onStatusChange={setStatusFilter}
          onSourceChange={setSourceFilter}
        />
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          <p className="font-medium">Error loading reminders</p>
          <p className="mt-1">{error}</p>
          <button
            onClick={fetchReminders}
            className="mt-2 text-red-800 underline text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-12 text-slate-500">
          <p className="text-lg">No reminders found</p>
          <p className="text-sm mt-1">Try changing the filters</p>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((reminder, index) => (
          <ReminderCard
            key={`${reminder.source}-${reminder.no}-${index}`}
            task={reminder.task}
            deadline={reminder.deadline}
            status={reminder.status}
            source={reminder.source}
            notes={reminder.notes}
            approval={reminder.approval}
          />
        ))}
      </div>

      {!loading && filtered.length > 0 && (
        <p className="text-center text-xs text-slate-400 mt-6">
          Showing {filtered.length} of {reminders.length} reminders
        </p>
      )}
    </main>
  );
}
