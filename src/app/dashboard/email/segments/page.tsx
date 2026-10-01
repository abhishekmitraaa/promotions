"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

export type Conjunction = "AND" | "OR";

export interface RuleCondition {
  type:
    | "attribute"
    | "consent"
    | "suppression"
    | "list"
    | "campaign_activity"
    | "opens"
    | "clicks"
    | "delivery_history"
    | "engagement";
  field?: string;
  operator: string;
  value?: string | boolean | number;
  listId?: string;
  campaignId?: string;
  url?: string;
  timeframeDays?: number;
  dimension?: string;
  days?: number;
}

export interface RuleGroup {
  conjunction: Conjunction;
  conditions: Array<RuleCondition | RuleGroup>;
}

interface Segment {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  criteria: string | RuleGroup;
  createdAt: string;
  audienceCount?: number | null;
}

interface ExplainableResult {
  totalMatching: number;
  totalAudience?: number;
  eligibleCount?: number;
  suppressedCount?: number;
  unsubscribedCount?: number;
  invalidCount?: number;
  explainSummary?: string;
  breakdown?: {
    statusCounts: Record<string, number>;
    suppressionReasons: Record<string, number>;
    consentMetrics: {
      hasMarketingConsentTrue: number;
      hasMarketingConsentFalse: number;
      verifiedTrue: number;
      verifiedFalse: number;
    };
  };
  sampleContacts?: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    hasMarketingConsent: boolean;
    verified: boolean;
    status: string;
  }>;
}

const CONDITION_CATEGORIES = [
  { id: "attribute", label: "Contact Attributes" },
  { id: "consent", label: "Consent & Verification" },
  { id: "suppression", label: "Suppression Protections" },
  { id: "list", label: "List Membership" },
  { id: "campaign_activity", label: "Campaign Activity" },
  { id: "opens", label: "Opens History" },
  { id: "clicks", label: "Clicks History" },
  { id: "delivery_history", label: "Delivery Status" },
  { id: "engagement", label: "Engagement & Recency" },
];

const ATTRIBUTE_FIELDS = [
  { id: "email", label: "Email Address" },
  { id: "firstName", label: "First Name" },
  { id: "lastName", label: "Last Name" },
  { id: "status", label: "Contact Status" },
  { id: "attributes.tier", label: "Custom Tier (attributes.tier)" },
  { id: "attributes.city", label: "Custom City (attributes.city)" },
  { id: "attributes.score", label: "Custom Score (attributes.score)" },
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
  const [rootGroup, setRootGroup] = useState<RuleGroup>({
    conjunction: "AND",
    conditions: [
      {
        type: "consent",
        field: "hasMarketingConsent",
        operator: "equals",
        value: true,
      },
    ],
  });
  const [saving, setSaving] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);

  // Live Explainable Preview state
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<ExplainableResult | null>(null);

  const evaluateSegmentCount = useCallback(async (segmentId: string) => {
    try {
      const res = await fetch(`/api/email/segments/${segmentId}/evaluate?limit=1`);
      if (res.ok) {
        const json = await res.json();
        setSegments((prev) =>
          prev.map((s) =>
            s.id === segmentId
              ? {
                  ...s,
                  audienceCount:
                    json.data?.eligibleCount !== undefined
                      ? json.data.eligibleCount
                      : json.data?.totalMatching ?? 0,
                }
              : s
          )
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
    setRootGroup({
      conjunction: "AND",
      conditions: [
        {
          type: "consent",
          field: "hasMarketingConsent",
          operator: "equals",
          value: true,
        },
      ],
    });
    setBuilderError(null);
    setPreviewResult(null);
    setShowBuilderModal(true);
  }

  function openEditModal(seg: Segment) {
    setEditingSegmentId(seg.id);
    setName(seg.name);
    setDescription(seg.description || "");

    let parsedCriteria: RuleGroup;
    if (typeof seg.criteria === "string") {
      try {
        parsedCriteria = JSON.parse(seg.criteria);
      } catch {
        parsedCriteria = { conjunction: "AND", conditions: [] };
      }
    } else {
      parsedCriteria = seg.criteria as RuleGroup;
    }

    if (!parsedCriteria.conditions || parsedCriteria.conditions.length === 0) {
      parsedCriteria = {
        conjunction: "AND",
        conditions: [
          {
            type: "consent",
            field: "hasMarketingConsent",
            operator: "equals",
            value: true,
          },
        ],
      };
    }

    setRootGroup(parsedCriteria);
    setBuilderError(null);
    setPreviewResult(null);
    setShowBuilderModal(true);
  }

  // Immutable path updaters to satisfy React compiler
  function updateNodeAtPath(path: number[], patch: Partial<RuleCondition | RuleGroup>) {
    setRootGroup((prev) => {
      const copy: RuleGroup = JSON.parse(JSON.stringify(prev));
      if (path.length === 0) {
        Object.assign(copy, patch);
        return copy;
      }
      let parentGroup: RuleGroup = copy;
      for (let i = 0; i < path.length - 1; i++) {
        parentGroup = parentGroup.conditions[path[i]] as RuleGroup;
      }
      const lastIndex = path[path.length - 1];
      Object.assign(parentGroup.conditions[lastIndex], patch);
      return copy;
    });
  }

  function updateConjunctionAtPath(path: number[], conjunction: Conjunction) {
    setRootGroup((prev) => {
      const copy: RuleGroup = JSON.parse(JSON.stringify(prev));
      let targetGroup: RuleGroup = copy;
      for (let i = 0; i < path.length; i++) {
        targetGroup = targetGroup.conditions[path[i]] as RuleGroup;
      }
      targetGroup.conjunction = conjunction;
      return copy;
    });
  }

  function addConditionAtPath(parentPath: number[]) {
    setRootGroup((prev) => {
      const copy: RuleGroup = JSON.parse(JSON.stringify(prev));
      let parent: RuleGroup = copy;
      for (let i = 0; i < parentPath.length; i++) {
        parent = parent.conditions[parentPath[i]] as RuleGroup;
      }
      parent.conditions.push({
        type: "attribute",
        field: "status",
        operator: "equals",
        value: "SUBSCRIBED",
      });
      return copy;
    });
  }

  function addSubGroupAtPath(parentPath: number[]) {
    setRootGroup((prev) => {
      const copy: RuleGroup = JSON.parse(JSON.stringify(prev));
      let parent: RuleGroup = copy;
      for (let i = 0; i < parentPath.length; i++) {
        parent = parent.conditions[parentPath[i]] as RuleGroup;
      }
      parent.conditions.push({
        conjunction: "OR",
        conditions: [
          { type: "opens", operator: "opened", timeframeDays: 30 },
          { type: "clicks", operator: "clicked", timeframeDays: 30 },
        ],
      });
      return copy;
    });
  }

  function removeNodeAtPath(parentPath: number[], index: number) {
    setRootGroup((prev) => {
      const copy: RuleGroup = JSON.parse(JSON.stringify(prev));
      let parent: RuleGroup = copy;
      for (let i = 0; i < parentPath.length; i++) {
        parent = parent.conditions[parentPath[i]] as RuleGroup;
      }
      parent.conditions.splice(index, 1);
      return copy;
    });
  }

  async function handleTestPreview() {
    setPreviewing(true);
    setBuilderError(null);
    try {
      const res = await fetch("/api/email/segments/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria: rootGroup, limit: 10 }),
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
    if (rootGroup.conditions.length === 0) {
      setBuilderError("At least one segment condition rule is required.");
      return;
    }

    setSaving(true);
    setBuilderError(null);

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
          criteria: rootGroup,
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

  // Recursive renderer for Group Nodes
  function renderGroupNode(group: RuleGroup, currentPath: number[]) {
    const isRoot = currentPath.length === 0;

    return (
      <div
        className={`rounded-xl border p-4 space-y-3 transition ${
          isRoot
            ? "bg-zinc-950 border-zinc-800"
            : "bg-zinc-900/60 border-zinc-700/60 ml-2 sm:ml-4 border-l-4 border-l-sky-500"
        }`}
      >
        {/* Group Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {isRoot ? "Root Expression" : "Nested Condition Group"}
            </span>
            <div className="inline-flex rounded-lg bg-zinc-900 p-0.5 border border-zinc-800 text-xs font-medium">
              <button
                type="button"
                onClick={() => updateConjunctionAtPath(currentPath, "AND")}
                className={`px-2.5 py-1 rounded-md transition ${
                  group.conjunction === "AND"
                    ? "bg-sky-600 text-white font-semibold"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                AND (Match All)
              </button>
              <button
                type="button"
                onClick={() => updateConjunctionAtPath(currentPath, "OR")}
                className={`px-2.5 py-1 rounded-md transition ${
                  group.conjunction === "OR"
                    ? "bg-amber-600 text-white font-semibold"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                OR (Match Any)
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => addConditionAtPath(currentPath)}
              className="text-xs px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-sky-400 rounded-md font-medium transition"
            >
              + Condition
            </button>
            {isRoot && (
              <button
                type="button"
                onClick={() => addSubGroupAtPath(currentPath)}
                className="text-xs px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-amber-400 rounded-md font-medium transition"
              >
                + Sub-Group
              </button>
            )}
            {!isRoot && (
              <button
                type="button"
                onClick={() => {
                  const parentPath = currentPath.slice(0, -1);
                  const selfIndex = currentPath[currentPath.length - 1];
                  removeNodeAtPath(parentPath, selfIndex);
                }}
                className="text-xs text-rose-400 hover:text-rose-300 px-2 py-1 transition"
                title="Remove Sub-Group"
              >
                ✕ Remove Group
              </button>
            )}
          </div>
        </div>

        {/* Group Children */}
        <div className="space-y-2">
          {group.conditions.map((item, index) => {
            const childPath = [...currentPath, index];
            if ("conjunction" in item && Array.isArray(item.conditions)) {
              return (
                <div key={`group-${childPath.join("-")}`}>
                  {renderGroupNode(item, childPath)}
                </div>
              );
            }
            return (
              <div key={`cond-${childPath.join("-")}`}>
                {renderConditionNode(item as RuleCondition, childPath, group.conditions.length > 1)}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Renderer for Leaf Condition Nodes
  function renderConditionNode(cond: RuleCondition, path: number[], canRemove: boolean) {
    const parentPath = path.slice(0, -1);
    const selfIndex = path[path.length - 1];

    return (
      <div className="bg-zinc-900 border border-zinc-800/80 rounded-lg p-3 flex flex-col md:flex-row items-start md:items-center gap-2 text-xs">
        {/* Type Category */}
        <select
          value={cond.type}
          onChange={(e) => {
            const newType = e.target.value as RuleCondition["type"];
            let defaultPatch: Partial<RuleCondition> = { type: newType };

            if (newType === "consent") {
              defaultPatch = {
                type: "consent",
                field: "hasMarketingConsent",
                operator: "equals",
                value: true,
              };
            } else if (newType === "suppression") {
              defaultPatch = {
                type: "suppression",
                operator: "is_not_suppressed",
              };
            } else if (newType === "list") {
              defaultPatch = {
                type: "list",
                operator: "in_list",
                listId: "",
              };
            } else if (newType === "opens") {
              defaultPatch = {
                type: "opens",
                operator: "opened",
                timeframeDays: 30,
              };
            } else if (newType === "clicks") {
              defaultPatch = {
                type: "clicks",
                operator: "clicked",
                timeframeDays: 30,
              };
            } else if (newType === "delivery_history") {
              defaultPatch = {
                type: "delivery_history",
                operator: "delivered",
              };
            } else if (newType === "engagement") {
              defaultPatch = {
                type: "engagement",
                dimension: "last_emailed",
                operator: "within_days",
                days: 30,
              };
            } else {
              defaultPatch = {
                type: "attribute",
                field: "status",
                operator: "equals",
                value: "SUBSCRIBED",
              };
            }
            updateNodeAtPath(path, defaultPatch);
          }}
          className="bg-zinc-950 border border-zinc-700/60 rounded px-2.5 py-1.5 text-sky-400 font-semibold focus:outline-none focus:border-sky-500 w-full md:w-auto"
        >
          {CONDITION_CATEGORIES.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.label}
            </option>
          ))}
        </select>

        {/* Dynamic Inputs based on type */}
        <div className="flex-1 flex flex-wrap items-center gap-2 w-full md:w-auto">
          {cond.type === "attribute" && (
            <>
              <select
                value={cond.field || "email"}
                onChange={(e) => updateNodeAtPath(path, { field: e.target.value })}
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200"
              >
                {ATTRIBUTE_FIELDS.map((af) => (
                  <option key={af.id} value={af.id}>
                    {af.label}
                  </option>
                ))}
              </select>
              <select
                value={cond.operator}
                onChange={(e) => updateNodeAtPath(path, { operator: e.target.value })}
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200"
              >
                <option value="equals">equals (=)</option>
                <option value="not_equals">does not equal (≠)</option>
                <option value="contains">contains</option>
                <option value="starts_with">starts with</option>
                <option value="greater_than">greater than (&gt;)</option>
                <option value="less_than">less than (&lt;)</option>
                <option value="is_not_empty">is set (exists)</option>
              </select>
              {cond.operator !== "is_not_empty" && (
                <input
                  type="text"
                  value={String(cond.value || "")}
                  onChange={(e) => updateNodeAtPath(path, { value: e.target.value })}
                  placeholder="Target value..."
                  className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-white flex-1 min-w-[120px]"
                />
              )}
            </>
          )}

          {cond.type === "consent" && (
            <>
              <select
                value={cond.field || "hasMarketingConsent"}
                onChange={(e) => updateNodeAtPath(path, { field: e.target.value })}
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200"
              >
                <option value="hasMarketingConsent">Promotional Marketing Consent</option>
                <option value="verified">Deliverability Verified</option>
                <option value="consentSource">Consent Source</option>
              </select>
              <select
                value={String(cond.value)}
                onChange={(e) => updateNodeAtPath(path, { value: e.target.value === "true" })}
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-emerald-400 font-medium"
              >
                <option value="true">Granted (True)</option>
                <option value="false">Revoked / Absent (False)</option>
              </select>
            </>
          )}

          {cond.type === "suppression" && (
            <select
              value={cond.operator}
              onChange={(e) => updateNodeAtPath(path, { operator: e.target.value })}
              className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200"
            >
              <option value="is_not_suppressed">Clean (NOT on suppression list)</option>
              <option value="is_suppressed">Suppressed (Hard bounce, Complaint, etc.)</option>
            </select>
          )}

          {cond.type === "list" && (
            <>
              <select
                value={cond.operator}
                onChange={(e) => updateNodeAtPath(path, { operator: e.target.value })}
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200"
              >
                <option value="in_list">Member of list</option>
                <option value="not_in_list">NOT member of list</option>
              </select>
              <input
                type="text"
                value={cond.listId || ""}
                onChange={(e) => updateNodeAtPath(path, { listId: e.target.value })}
                placeholder="List UUID..."
                className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-white flex-1 font-mono text-[11px]"
              />
            </>
          )}

          {cond.type === "campaign_activity" && (
            <>
              <select
                value={cond.operator}
                onChange={(e) => updateNodeAtPath(path, { operator: e.target.value })}
                className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200"
              >
                <option value="targeted">Targeted by campaign</option>
                <option value="received">Delivered / Received email</option>
                <option value="not_targeted">Never targeted</option>
              </select>
              <input
                type="text"
                value={cond.campaignId || ""}
                onChange={(e) => updateNodeAtPath(path, { campaignId: e.target.value })}
                placeholder="Optional Campaign UUID..."
                className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-white flex-1 font-mono text-[11px]"
              />
            </>
          )}

          {cond.type === "opens" && (
            <>
              <select
                value={cond.operator}
                onChange={(e) => updateNodeAtPath(path, { operator: e.target.value })}
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200"
              >
                <option value="opened">Has opened email</option>
                <option value="not_opened">Has NOT opened email</option>
                <option value="opened_within_days">Opened within last N days</option>
              </select>
              {cond.operator === "opened_within_days" && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={cond.timeframeDays || 30}
                    onChange={(e) =>
                      updateNodeAtPath(path, {
                        timeframeDays: parseInt(e.target.value) || 30,
                      })
                    }
                    className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-white"
                  />
                  <span className="text-zinc-500">days</span>
                </div>
              )}
            </>
          )}

          {cond.type === "clicks" && (
            <>
              <select
                value={cond.operator}
                onChange={(e) => updateNodeAtPath(path, { operator: e.target.value })}
                className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200"
              >
                <option value="clicked">Has clicked any link</option>
                <option value="not_clicked">Has NOT clicked links</option>
                <option value="clicked_within_days">Clicked within last N days</option>
              </select>
              {cond.operator === "clicked_within_days" && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={cond.timeframeDays || 30}
                    onChange={(e) =>
                      updateNodeAtPath(path, {
                        timeframeDays: parseInt(e.target.value) || 30,
                      })
                    }
                    className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-white"
                  />
                  <span className="text-zinc-500">days</span>
                </div>
              )}
            </>
          )}

          {cond.type === "delivery_history" && (
            <select
              value={cond.operator}
              onChange={(e) => updateNodeAtPath(path, { operator: e.target.value })}
              className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200"
            >
              <option value="delivered">Successfully Delivered</option>
              <option value="bounced">Bounced (Hard or Soft)</option>
              <option value="complained">Spam Complaint Logged</option>
              <option value="failed">Failed Delivery</option>
              <option value="not_bounced">Clean (Zero Bounces)</option>
            </select>
          )}

          {cond.type === "engagement" && (
            <>
              <select
                value={cond.operator}
                onChange={(e) => updateNodeAtPath(path, { operator: e.target.value })}
                className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-200"
              >
                <option value="within_days">Emailed within last N days</option>
                <option value="older_than_days">Not emailed in last N days (Cold)</option>
                <option value="never">Never emailed before</option>
              </select>
              {cond.operator !== "never" && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={cond.days || 30}
                    onChange={(e) =>
                      updateNodeAtPath(path, {
                        days: parseInt(e.target.value) || 30,
                      })
                    }
                    className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-white"
                  />
                  <span className="text-zinc-500">days</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Remove Button */}
        {canRemove && (
          <button
            type="button"
            onClick={() => removeNodeAtPath(parentPath, selfIndex)}
            className="text-zinc-500 hover:text-rose-400 p-1 transition"
            title="Remove Condition"
          >
            ✕
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Audience Segments</h1>
          <p className="text-sm text-zinc-400">
            Advanced audience engine: nested AND/OR groups, contact traits, opens, clicks, delivery history, consent, and explainable breakdowns.
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
            className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition shadow-lg shadow-sky-600/20"
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
                      ? `${seg.audienceCount} Eligible`
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

      {/* Advanced Segment Rule Builder Modal */}
      {showBuilderModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-4xl w-full p-6 space-y-4 max-h-[92vh] flex flex-col shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 shrink-0">
              <div>
                <h2 className="text-lg font-bold text-white">
                  {editingSegmentId ? "Edit Advanced Audience Segment" : "Create Advanced Audience Segment"}
                </h2>
                <p className="text-xs text-zinc-400">
                  Compose nested AND/OR criteria trees across traits, engagement, opens, clicks, delivery history, and consent.
                </p>
              </div>
              <button
                onClick={() => setShowBuilderModal(false)}
                className="text-zinc-500 hover:text-white text-lg p-1"
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
                    placeholder="e.g. VIP Engaged Customers"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-zinc-400 block mb-1">Description</label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Segment rationale & intent..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              {/* Recursive Rule Tree */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">
                  Criteria Expression Tree
                </label>
                {renderGroupNode(rootGroup, [])}
              </div>

              {/* Explainable Audience Breakdown Box */}
              {previewResult && (
                <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
                    <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                      Explainable Audience Breakdown
                    </span>
                    <span className="text-xs text-zinc-500 font-mono">
                      Total Matching: {previewResult.totalMatching}
                    </span>
                  </div>

                  {/* Summary Banner */}
                  {previewResult.explainSummary && (
                    <p className="text-xs text-sky-300 bg-sky-950/40 border border-sky-800/40 px-3 py-2 rounded-lg font-medium">
                      💡 {previewResult.explainSummary}
                    </p>
                  )}

                  {/* Metrics Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-2.5">
                      <div className="text-emerald-400 font-bold font-mono text-base">
                        {previewResult.eligibleCount ?? previewResult.totalMatching}
                      </div>
                      <div className="text-zinc-400 text-[11px] mt-0.5">Eligible to Send</div>
                    </div>
                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-2.5">
                      <div className="text-amber-400 font-bold font-mono text-base">
                        {previewResult.unsubscribedCount ?? 0}
                      </div>
                      <div className="text-zinc-400 text-[11px] mt-0.5">Missing Consent</div>
                    </div>
                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-2.5">
                      <div className="text-rose-400 font-bold font-mono text-base">
                        {previewResult.suppressedCount ?? 0}
                      </div>
                      <div className="text-zinc-400 text-[11px] mt-0.5">Suppressed</div>
                    </div>
                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-2.5">
                      <div className="text-zinc-400 font-bold font-mono text-base">
                        {previewResult.invalidCount ?? 0}
                      </div>
                      <div className="text-zinc-400 text-[11px] mt-0.5">Invalid Email</div>
                    </div>
                  </div>

                  {/* Sample Contacts */}
                  {previewResult.sampleContacts && previewResult.sampleContacts.length > 0 && (
                    <div className="space-y-1.5 pt-2 border-t border-zinc-800 text-xs">
                      <p className="text-zinc-500 font-medium">Deterministic Sample Preview:</p>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {previewResult.sampleContacts.slice(0, 5).map((c) => (
                          <div
                            key={c.id}
                            className="flex items-center justify-between text-[11px] bg-zinc-900/70 px-2.5 py-1.5 rounded border border-zinc-800/80 font-mono"
                          >
                            <span className="text-zinc-200">
                              {c.email} {c.firstName ? `(${c.firstName})` : ""}
                            </span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] ${
                                c.hasMarketingConsent
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : "bg-rose-500/10 text-rose-400"
                              }`}
                            >
                              {c.hasMarketingConsent ? "CONSENTED" : "NO CONSENT"}
                            </span>
                          </div>
                        ))}
                      </div>
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
                  className="px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-sky-400 rounded-lg text-xs font-semibold transition disabled:opacity-50 flex items-center gap-1.5"
                >
                  {previewing ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-sky-400 border-t-transparent rounded-full animate-spin"></div>
                      Evaluating Stream...
                    </>
                  ) : (
                    "Live Explainable Preview"
                  )}
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
                    className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-sm font-medium transition disabled:opacity-50 shadow-md shadow-sky-600/20"
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
