"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface SegmentCondition {
  field: string;
  operator: "equals" | "not_equals" | "contains" | "starts_with" | "in" | "not_in";
  value: string | boolean;
}

interface SegmentCriteria {
  conjunction: "AND" | "OR";
  conditions: SegmentCondition[];
}

interface Segment {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  criteria: string | SegmentCriteria;
  createdAt: string;
  audienceCount?: number | null;
}

interface PreviewContact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  hasMarketingConsent: boolean;
  verified: boolean;
}

const SUPPORTED_FIELDS = [
  { id: "marketingConsent", label: "Marketing Consent (Law)", type: "boolean" },
  { id: "verified", label: "Email Verified (Deliverability)", type: "boolean" },
  { id: "status", label: "Contact Status", type: "status" },
  { id: "email", label: "Email Address", type: "text" },
  { id: "firstName", label: "First Name", type: "text" },
  { id: "lastName", label: "Last Name", type: "text" },
  { id: "city", label: "City (Attribute)", type: "text" },
  { id: "category", label: "Category (Attribute)", type: "text" },
];

const SUPPORTED_OPERATORS = [
  { id: "equals", label: "equals (=)" },
  { id: "not_equals", label: "does not equal (≠)" },
  { id: "contains", label: "contains" },
  { id: "starts_with", label: "starts with" },
  { id: "in", label: "is in (comma-separated)" },
  { id: "not_in", label: "is not in (comma-separated)" },
];

export default function SegmentsPage() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals state
  const [showBuilderModal, setShowBuilderModal] = useState(false);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);

  // Builder form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [conjunction, setConjunction] = useState<"AND" | "OR">("AND");
  const [conditions, setConditions] = useState<SegmentCondition[]>([
    { field: "marketingConsent", operator: "equals", value: true },
  ]);
  const [saving, setSaving] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);

  // Live Preview state
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<{
    totalMatching: number;
    contacts: PreviewContact[];
  } | null>(null);

  const evaluateSegmentCount = useCallback(async (segmentId: string) => {
    try {
      const res = await fetch(`/api/email/segments/${segmentId}/evaluate?limit=1`);
      if (res.ok) {
        const json = await res.json();
        setSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? { ...s, audienceCount: json.data?.totalMatching ?? 0 } : s))
        );
      }
    } catch {
      // Safe fallback
    }
  }, []);

  const loadSegments = useCallback(async () => {
    try {
      const res = await fetch("/api/email/segments");
      if (res.ok) {
        const json = await res.json();
        const loaded: Segment[] = json.data || [];
        setSegments(loaded);

        // Fetch counts in background
        for (const seg of loaded) {
          evaluateSegmentCount(seg.id);
        }
      }
    } catch {
      // Safe fallback
    } finally {
      setLoading(false);
    }
  }, [evaluateSegmentCount]);

  useEffect(() => {
    loadSegments();
  }, [loadSegments]);

  function openCreateModal() {
    setEditingSegmentId(null);
    setName("");
    setDescription("");
    setConjunction("AND");
    setConditions([
      { field: "marketingConsent", operator: "equals", value: true },
    ]);
    setBuilderError(null);
    setPreviewResult(null);
    setShowBuilderModal(true);
  }

  function openEditModal(seg: Segment) {
    setEditingSegmentId(seg.id);
    setName(seg.name);
    setDescription(seg.description || "");

    let parsedCriteria: SegmentCriteria;
    if (typeof seg.criteria === "string") {
      try {
        parsedCriteria = JSON.parse(seg.criteria);
      } catch {
        parsedCriteria = { conjunction: "AND", conditions: [] };
      }
    } else {
      parsedCriteria = seg.criteria as SegmentCriteria;
    }

    const rawConjunction =
      parsedCriteria.conjunction ||
      (parsedCriteria as { conjunction?: "AND" | "OR"; operator?: "AND" | "OR" }).operator ||
      "AND";
    setConjunction(rawConjunction === "OR" ? "OR" : "AND");
    setConditions(
      parsedCriteria.conditions && parsedCriteria.conditions.length > 0
        ? parsedCriteria.conditions.map((c) => ({
            field: c.field,
            operator: c.operator,
            value: c.value,
          }))
        : [{ field: "marketingConsent", operator: "equals", value: true }]
    );

    setBuilderError(null);
    setPreviewResult(null);
    setShowBuilderModal(true);
  }

  function handleAddCondition() {
    setConditions((prev) => [
      ...prev,
      { field: "status", operator: "equals", value: "SUBSCRIBED" },
    ]);
  }

  function handleRemoveCondition(index: number) {
    setConditions((prev) => prev.filter((_, i) => i !== index));
  }

  function handleConditionChange(
    index: number,
    key: "field" | "operator" | "value",
    val: unknown
  ) {
    setConditions((prev) => {
      const copy = [...prev];
      const target = { ...copy[index] };

      if (key === "field") {
        target.field = val as string;
        // Reset default values based on field
        if (val === "marketingConsent" || val === "verified") {
          target.operator = "equals";
          target.value = true;
        } else if (val === "status") {
          target.operator = "equals";
          target.value = "SUBSCRIBED";
        } else {
          target.operator = "contains";
          target.value = "";
        }
      } else if (key === "operator") {
        target.operator = val as SegmentCondition["operator"];
      } else if (key === "value") {
        target.value = val as string | boolean;
      }

      copy[index] = target;
      return copy;
    });
  }

  async function handleTestPreview() {
    setPreviewing(true);
    setBuilderError(null);
    try {
      const criteriaPayload = {
        conjunction,
        conditions: conditions.map((c) => ({
          field: c.field,
          operator: c.operator,
          value: c.value,
        })),
      };

      const res = await fetch("/api/email/segments/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria: criteriaPayload, limit: 10 }),
      });

      if (res.ok) {
        const json = await res.json();
        setPreviewResult(json.data);
      } else {
        const errJson = await res.json();
        setBuilderError(errJson.error?.message || "Failed to evaluate segment preview");
      }
    } catch (err) {
      setBuilderError(err instanceof Error ? err.message : "Error evaluating preview");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleSaveSegment(e: React.FormEvent) {
    e.preventDefault();
    if (conditions.length === 0) {
      setBuilderError("At least one segment condition rule is required.");
      return;
    }

    setSaving(true);
    setBuilderError(null);

    const criteriaPayload = {
      conjunction,
      conditions: conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.value,
      })),
    };

    try {
      const url = editingSegmentId
        ? `/api/email/segments/${editingSegmentId}`
        : "/api/email/segments";
      const method = editingSegmentId ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          criteria: criteriaPayload,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to save segment");
      }

      setShowBuilderModal(false);
      loadSegments();
    } catch (err) {
      setBuilderError(err instanceof Error ? err.message : "Failed to save segment");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(seg: Segment) {
    try {
      const res = await fetch(`/api/email/segments/${seg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !seg.active }),
      });
      if (res.ok) loadSegments();
    } catch {
      // Safe fallback
    }
  }

  async function handleDeleteSegment(segmentId: string, segmentName: string) {
    if (!confirm(`Are you sure you want to delete segment "${segmentName}"?`)) return;
    try {
      const res = await fetch(`/api/email/segments/${segmentId}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error?.message || "Failed to delete segment");
        return;
      }
      loadSegments();
    } catch {
      // Safe fallback
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Audience Segments</h1>
          <p className="text-sm text-zinc-400">
            Dynamic rule builder with boolean expressions (AND/OR), field operators, and live audience preview.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/email"
            className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium transition"
          >
            &larr; Overview
          </Link>
          <button
            onClick={openCreateModal}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            + Create Segment
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : segments.length === 0 ? (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center">
          <p className="text-zinc-400">No audience segments defined yet.</p>
          <button
            onClick={openCreateModal}
            className="mt-4 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition"
          >
            Create Your First Segment
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {segments.map((seg) => (
            <div
              key={seg.id}
              className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-medium border ${
                      seg.active
                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                        : "bg-zinc-800 text-zinc-400 border-zinc-700"
                    }`}
                  >
                    {seg.active ? "Active" : "Inactive"}
                  </span>
                  <span className="text-xs text-sky-400 font-mono font-semibold">
                    {seg.audienceCount !== undefined && seg.audienceCount !== null
                      ? `${seg.audienceCount} Contacts`
                      : "Calculating..."}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-white mt-2">{seg.name}</h3>
                <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                  {seg.description || "Dynamic segment evaluated at dispatch snapshot time."}
                </p>
              </div>

              <div className="mt-5 pt-4 border-t border-zinc-800 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openEditModal(seg)}
                    className="text-sky-400 hover:text-sky-300 font-medium transition"
                  >
                    Edit Rules
                  </button>
                  <span className="text-zinc-600">|</span>
                  <button
                    onClick={() => handleToggleActive(seg)}
                    className="text-zinc-300 hover:text-white transition"
                  >
                    {seg.active ? "Deactivate" : "Activate"}
                  </button>
                </div>
                <button
                  onClick={() => handleDeleteSegment(seg.id, seg.name)}
                  className="text-rose-400 hover:text-rose-300 transition"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Interactive Segment Rule Builder Modal */}
      {showBuilderModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-2xl w-full p-6 space-y-4 max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 shrink-0">
              <div>
                <h2 className="text-lg font-bold text-white">
                  {editingSegmentId ? "Edit Audience Segment" : "Create Audience Segment"}
                </h2>
                <p className="text-xs text-zinc-400">
                  Injection-resistant structured rules with AND / OR conjunctions.
                </p>
              </div>
              <button
                onClick={() => setShowBuilderModal(false)}
                className="text-zinc-500 hover:text-white"
              >
                ✕
              </button>
            </div>

            {builderError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg text-xs shrink-0">
                {builderError}
              </div>
            )}

            <form onSubmit={handleSaveSegment} className="space-y-4 overflow-y-auto flex-1 pr-1">
              {/* Basic Info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Segment Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Opted-In Active Customers"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Description</label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Segment rationale..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              {/* Conjunction logic */}
              <div className="bg-zinc-950 border border-zinc-800 p-3 rounded-lg flex items-center justify-between">
                <span className="text-xs text-zinc-300 font-medium">Rule Conjunction Logic:</span>
                <div className="flex items-center gap-3 text-xs">
                  <label className="flex items-center gap-1.5 cursor-pointer text-zinc-200">
                    <input
                      type="radio"
                      name="conjunction"
                      checked={conjunction === "AND"}
                      onChange={() => setConjunction("AND")}
                    />
                    <span>Match ALL conditions (AND)</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-zinc-200">
                    <input
                      type="radio"
                      name="conjunction"
                      checked={conjunction === "OR"}
                      onChange={() => setConjunction("OR")}
                    />
                    <span>Match ANY condition (OR)</span>
                  </label>
                </div>
              </div>

              {/* Conditions List */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                    Conditions ({conditions.length})
                  </label>
                  <button
                    type="button"
                    onClick={handleAddCondition}
                    className="text-xs text-sky-400 hover:text-sky-300 font-medium transition"
                  >
                    + Add Condition
                  </button>
                </div>

                {conditions.map((cond, index) => {
                  const fieldDef =
                    SUPPORTED_FIELDS.find((f) => f.id === cond.field) || SUPPORTED_FIELDS[0];

                  return (
                    <div
                      key={index}
                      className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 flex flex-col sm:flex-row items-center gap-2"
                    >
                      {/* Field Selection */}
                      <select
                        value={cond.field}
                        onChange={(e) => handleConditionChange(index, "field", e.target.value)}
                        className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500 w-full sm:w-auto"
                      >
                        {SUPPORTED_FIELDS.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </select>

                      {/* Operator Selection */}
                      <select
                        value={cond.operator}
                        onChange={(e) => handleConditionChange(index, "operator", e.target.value)}
                        className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500 w-full sm:w-auto"
                      >
                        {SUPPORTED_OPERATORS.map((op) => (
                          <option key={op.id} value={op.id}>
                            {op.label}
                          </option>
                        ))}
                      </select>

                      {/* Value Input */}
                      <div className="flex-1 w-full sm:w-auto">
                        {fieldDef.type === "boolean" ? (
                          <select
                            value={String(cond.value)}
                            onChange={(e) =>
                              handleConditionChange(index, "value", e.target.value === "true")
                            }
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
                          >
                            <option value="true">True (Yes)</option>
                            <option value="false">False (No)</option>
                          </select>
                        ) : fieldDef.type === "status" ? (
                          <select
                            value={String(cond.value)}
                            onChange={(e) => handleConditionChange(index, "value", e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
                          >
                            <option value="SUBSCRIBED">SUBSCRIBED</option>
                            <option value="UNSUBSCRIBED">UNSUBSCRIBED</option>
                            <option value="BOUNCED">BOUNCED</option>
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={String(cond.value || "")}
                            onChange={(e) => handleConditionChange(index, "value", e.target.value)}
                            placeholder="Condition value..."
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-sky-500"
                          />
                        )}
                      </div>

                      {/* Remove Button */}
                      {conditions.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveCondition(index)}
                          className="text-zinc-500 hover:text-rose-400 p-1"
                          title="Remove condition"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Preview Box */}
              {previewResult && (
                <div className="p-3 bg-zinc-950 border border-zinc-800 rounded-lg text-xs space-y-2">
                  <div className="flex justify-between items-center font-semibold text-white">
                    <span>Matching Audience Estimate:</span>
                    <span className="text-emerald-400 font-mono text-sm">
                      {previewResult.totalMatching} Contacts
                    </span>
                  </div>
                  {previewResult.contacts.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-zinc-800">
                      <p className="text-zinc-500">Sample contacts:</p>
                      {previewResult.contacts.slice(0, 3).map((c) => (
                        <p key={c.id} className="text-zinc-300 font-mono">
                          • {c.email} ({c.hasMarketingConsent ? "Opted In" : "No Consent"})
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Actions Footer */}
              <div className="flex items-center justify-between pt-3 border-t border-zinc-800 shrink-0">
                <button
                  type="button"
                  onClick={handleTestPreview}
                  disabled={previewing}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-sky-400 rounded-lg text-xs font-medium transition disabled:opacity-50"
                >
                  {previewing ? "Evaluating..." : "Preview Matching Audience"}
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowBuilderModal(false)}
                    className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50"
                  >
                    {saving ? "Saving..." : editingSegmentId ? "Update Segment" : "Create Segment"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
