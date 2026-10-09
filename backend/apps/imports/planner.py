"""Board 40 analysis, value maps, row planning and validation (§4.3, §4.6, §4.7).

Pure: `plan_import()` takes the parsed file, the column mapping, the user's explicit value choices and a
snapshot of the project (`PlanProject`, built by `services.plan_project`) and returns the validation summary,
one planned row per data row and the normalised mapping. I2, I4 and the I5 dry run call it, and the runner calls
it once per run (§5.2): it is deterministic for a given file + mapping + project state. Twin of the mock's
`src/lib/mock/import/plan.ts`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .mapping import (
    date_order_of,
    first_person,
    infer_type,
    match_person,
    match_priority,
    match_status,
    match_type,
    parse_date,
    parse_duration_cell,
    parse_number,
    round_half_up,
    value_key,
)
from .parsing import ParsedFile
from .presets import FIELD_LABELS, MULTI_COLUMN

LIMITS = {"statuses": 50, "types": 20, "people": 200, "labels": 100, "epics": 50, "labels_per_task": 20, "options": 50}
MAX_TITLE = 200
MAX_EPIC_NAME = 80
MAX_DESCRIPTION = 20_000
MAX_ESTIMATE = 99
MAX_TIME_MINUTES = 60_000
MAX_TEXT_FIELD = 120
MAX_NUMBER_FIELD = 1_000_000_000
MAX_LABEL = 24

_LIST_SPLIT = re.compile(r"[;,]")
_REF_SPLIT = re.compile(r"[\s,;]+")


@dataclass
class PlanProject:
    """What planning needs to know about the target project and the importer (plain data, no ORM)."""

    key: str
    task_seq: int
    statuses: list[dict[str, Any]]  # {id, name, glyph, position}
    default_status_id: str
    members: list[dict[str, Any]]  # {id, name, email}
    importer_id: str
    perms: frozenset[str]
    labels: list[dict[str, Any]]  # {id, name}
    epics: list[dict[str, Any]]  # {id, name}
    sprints: list[dict[str, Any]]  # {id, name} (not completed)
    custom_fields: list[dict[str, Any]]  # {id, name, type, options: [{id, name}]}
    tasks: list[dict[str, Any]]  # {id, key, parentId, sprintId, epicId} (live tasks)


@dataclass
class PlannedRow:
    row: int
    outcome: str  # task | epic | skipped
    key: str | None
    task_index: int | None
    issues: list[dict[str, Any]]
    values: dict[str, Any]
    description: str
    refs: list[str]
    status_value: str = ""
    parent: dict[str, Any] | None = None  # {"row": n} | {"taskId": id}
    epic_row: int | None = None
    epic_id: str | None = None
    epic_name: str | None = None
    blocked_by: list[dict[str, Any]] = field(default_factory=list)  # [{ref, row?|taskId?}]
    blocks: list[dict[str, Any]] = field(default_factory=list)
    new_options: dict[str, str] = field(default_factory=dict)  # fieldId → option name to create
    # planning scratch
    parent_ref: str = ""
    epic_ref: str = ""
    is_epic: bool = False

    def preview(self) -> dict[str, Any]:
        return {"row": self.row, "outcome": self.outcome, "key": self.key, "issues": self.issues, "values": self.values}


@dataclass
class PlanResult:
    validation: dict[str, Any]
    rows: list[PlannedRow]
    mapping: dict[str, Any]


# ───────────────────────── analysis (I2) ─────────────────────────


def analyze_columns(file: ParsedFile, members: list[dict[str, Any]]) -> list[dict[str, Any]]:
    names = {str(m["name"]).lower() for m in members}
    out = []
    for index, name in enumerate(file.header):
        values = [r[index] if index < len(r) else "" for r in file.rows]
        filled = [v.strip() for v in values if v.strip()]
        samples: list[str] = []
        for v in filled:
            s = v[:40]
            if s not in samples:
                samples.append(s)
            if len(samples) == 3:
                break
        inferred = infer_type(values, names)
        out.append(
            {
                "index": index,
                "name": name,
                "samples": samples,
                "inferredType": inferred,
                "emptyCount": len(values) - len(filled),
                "distinctCount": len({v.lower() for v in filled}),
                "dateOrder": date_order_of(filled) if inferred == "date" else None,
            }
        )
    return out


# ───────────────────────── helpers ─────────────────────────


def _tally(values: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    index: dict[str, int] = {}
    for v in values:
        k = value_key(v)
        if not k:
            continue
        i = index.get(k)
        if i is None:
            index[k] = len(out)
            out.append({"key": k, "value": v.strip(), "count": 1})
        else:
            out[i]["count"] += 1
    return out


def _more(n: int, one: str, many: str) -> str:
    return f"Map {n} more {one if n == 1 else many}"


def _empty_values() -> dict[str, Any]:
    return {
        "title": "",
        "type": "feature",
        "statusId": None,
        "assigneeId": None,
        "priority": 0,
        "estimate": None,
        "timeEstimateMinutes": None,
        "startDate": None,
        "dueDate": None,
        "labels": [],
        "epic": None,
        "sprintId": None,
        "parent": None,
        "customFields": {},
    }


def _number_out(n: float) -> int | float:
    return int(n) if float(n).is_integer() else n


# ───────────────────────── the plan ─────────────────────────


def plan_import(
    file: ParsedFile,
    columns: list[dict[str, Any]],
    user: dict[str, dict[str, Any]],
    project: PlanProject,
    revision: int = 0,
) -> PlanResult:
    rows_in = file.rows

    def cols(f: str) -> list[int]:
        return [i for i, c in enumerate(columns) if c.get("field") == f]

    def col(f: str) -> int:
        found = cols(f)
        return found[0] if found else -1

    def cell(r: list[str], i: int) -> str:
        return (r[i] if 0 <= i < len(r) else "").strip()

    can_epic = "epic.manage" in project.perms
    can_assign = "task.assign" in project.perms
    can_options = "field.manage" in project.perms

    orders: dict[int, str | None] = {}

    def order_of(i: int) -> str | None:
        if i not in orders:
            orders[i] = date_order_of(r[i] if i < len(r) else "" for r in rows_in)
        return orders[i]

    fields_by_id = {str(f["id"]): f for f in project.custom_fields}
    status_col, type_col, assignee_col = col("status"), col("type"), col("assignee")
    person_cols = [
        i
        for i, c in enumerate(columns)
        if c.get("field") == "customField"
        and (fields_by_id.get(str(c.get("customFieldId"))) or {}).get("type") == "user"
    ]
    user_statuses = user.get("statuses") or {}
    user_types = user.get("types") or {}
    user_people = user.get("people") or {}

    # value maps
    status_vals: list[dict[str, Any]] = []
    if status_col >= 0:
        for v in _tally([cell(r, status_col) for r in rows_in]):
            explicit = v["key"] in user_statuses
            target = user_statuses[v["key"]] if explicit else match_status(v["value"], project.statuses)
            status_vals.append({**v, "target": target, "auto": not explicit and target is not None})
    type_vals: list[dict[str, Any]] = []
    if type_col >= 0:
        for v in _tally([cell(r, type_col) for r in rows_in]):
            explicit = v["key"] in user_types
            target = user_types[v["key"]] if explicit else match_type(v["value"], can_epic)
            type_vals.append({**v, "target": target, "auto": not explicit and target is not None})
    person_cells = [
        first_person(r[i] if i < len(r) else "") for i in [assignee_col, *person_cols] if i >= 0 for r in rows_in
    ]
    people_vals: list[dict[str, Any]] = []
    for v in _tally(person_cells):
        if v["key"] in user_people:
            people_vals.append({**v, "target": user_people[v["key"]], "auto": False, "matchedBy": None})
            continue
        target, matched_by = match_person(v["value"], project.members)
        # Without task.assign every suggestion except the importer becomes "Leave unassigned".
        if not can_assign and target and target != project.importer_id:
            target, matched_by = None, None
        people_vals.append({**v, "target": target, "auto": target is not None, "matchedBy": matched_by})
    status_map = {v["key"]: v["target"] for v in status_vals}
    type_map = {v["key"]: v["target"] for v in type_vals}
    people_map = {v["key"]: v["target"] for v in people_vals}

    # identities (sourceId columns), lower-cased; the first row wins
    id_cols = cols("sourceId")
    identity: dict[str, int] = {}
    refs_of: list[list[str]] = []
    for i, r in enumerate(rows_in):
        refs = [k for k in (value_key(r[c] if c < len(r) else "") for c in id_cols) if k]
        for ref in refs:
            identity.setdefault(ref, i)
        refs_of.append(refs)
    existing_by_key = {str(t["key"]).lower(): t for t in project.tasks}
    tasks_by_id = {str(t["id"]): t for t in project.tasks}
    label_names = {str(lb["name"]).lower() for lb in project.labels}
    epic_by_name = {str(e["name"]).lower(): e for e in project.epics}
    sprint_by_name = {str(s["name"]).lower(): s for s in project.sprints}

    title_col, desc_col = col("title"), col("description")
    due_col, start_col, est_col, time_col = col("dueDate"), col("startDate"), col("estimate"), col("timeEstimate")
    priority_col, parent_col, epic_col, sprint_col = col("priority"), col("parent"), col("epic"), col("sprint")
    time_unit = (columns[time_col].get("unit") if time_col >= 0 else None) or "hours"
    custom_cols = [(i, c) for i, c in enumerate(columns) if c.get("field") == "customField" and c.get("customFieldId")]

    # pass 1: per-row values and skip checks
    drafts: list[PlannedRow] = []
    for i, r in enumerate(rows_in):
        values = _empty_values()
        skip: dict[str, Any] | None = None

        def skip_if(fld: str | None, reason: str, value: str) -> None:
            nonlocal skip
            if skip is None:
                skip = {"severity": "skip", "field": fld, "reason": reason, "value": value}

        title = cell(r, title_col)
        values["title"] = title
        type_raw = cell(r, type_col)
        typ = "feature" if type_col < 0 or not type_raw else type_map.get(value_key(type_raw))
        values["type"] = typ or "feature"
        is_epic = typ == "epic"
        if not title:
            skip_if("title", "Missing title", "")
        elif is_epic and len(title) > MAX_EPIC_NAME:
            skip_if("title", "Epic name over 80 characters", f"{title[:40]}…")
        elif len(title) > MAX_TITLE:
            skip_if("title", "Title over 200 characters", f"{title[:40]}…")

        description = r[desc_col] if 0 <= desc_col < len(r) else ""
        if desc_col >= 0 and len(description) > MAX_DESCRIPTION:
            skip_if("description", "Description over 20,000 characters", f"{description[:40]}…")

        due_raw, start_raw = cell(r, due_col), cell(r, start_col)
        due = parse_date(due_raw, order_of(due_col)) if due_raw else None
        start = parse_date(start_raw, order_of(start_col)) if start_raw else None
        if due_raw and not due:
            skip_if("dueDate", "Invalid due date", due_raw)
        if start_raw and not start:
            skip_if("startDate", "Invalid start date", start_raw)
        if start and due and start > due:
            skip_if("startDate", "Start date after due date", start_raw)
        values["dueDate"], values["startDate"] = due, start

        est_raw = cell(r, est_col)
        if est_raw:
            n = parse_number(est_raw, file.delimiter)
            if n is None or n < 0:
                skip_if("estimate", "Estimate is not a number", est_raw)
            elif round_half_up(n) > MAX_ESTIMATE:
                skip_if("estimate", "Estimate over 99 points", est_raw)
            else:
                values["estimate"] = round_half_up(n)
        time_raw = cell(r, time_col)
        if time_raw:
            minutes = parse_duration_cell(time_raw, time_unit)
            if minutes is None:
                skip_if("timeEstimate", "Time estimate is not a duration", time_raw)
            elif minutes > MAX_TIME_MINUTES:
                skip_if("timeEstimate", "Time estimate over 1000 hours", time_raw)
            else:
                values["timeEstimateMinutes"] = minutes if minutes > 0 else None

        new_options: dict[str, str] = {}
        for ci, c in custom_cols:
            f = fields_by_id.get(str(c["customFieldId"]))
            raw = cell(r, ci)
            if f is None or not raw:
                continue
            fid, fname = str(f["id"]), f["name"]
            val: Any = None
            if f["type"] == "text":
                if len(raw) > MAX_TEXT_FIELD:
                    skip_if("customField", f"{fname}: up to 120 characters", f"{raw[:40]}…")
                else:
                    val = raw
            elif f["type"] == "number":
                n = parse_number(raw, file.delimiter)
                if n is None or n < 0 or n > MAX_NUMBER_FIELD:
                    skip_if("customField", f"{fname}: enter a number from 0 to 1,000,000,000", raw)
                else:
                    val = _number_out(n)
            elif f["type"] == "date":
                day = parse_date(raw, order_of(ci))
                if not day:
                    skip_if("customField", f"{fname}: invalid date", raw)
                else:
                    val = day
            elif f["type"] == "select":
                opt = next((o for o in f["options"] if str(o["name"]).lower() == raw.lower()), None)
                if opt is not None:
                    val = str(opt["id"])
                else:
                    new_options[fid] = raw
            elif f["type"] == "user":
                val = people_map.get(value_key(first_person(raw)))
            if val is not None:
                values["customFields"][fid] = val

        status_value = cell(r, status_col)
        values["statusId"] = (
            project.default_status_id if status_col < 0 or not status_value else status_map.get(value_key(status_value))
        )
        values["assigneeId"] = (
            None if assignee_col < 0 else people_map.get(value_key(first_person(cell(r, assignee_col))))
        )
        values["priority"] = match_priority(cell(r, priority_col))

        drafts.append(
            PlannedRow(
                row=i + 2,
                outcome="skipped" if skip else "epic" if is_epic else "task",
                key=None,
                task_index=None,
                issues=[skip] if skip else [],
                values=values,
                description=description,
                refs=refs_of[i],
                status_value=status_value,
                new_options=new_options,
                parent_ref=cell(r, parent_col),
                epic_ref=cell(r, epic_col),
                is_epic=is_epic,
            )
        )

    def live(d: PlannedRow | None) -> bool:
        return d is not None and d.outcome != "skipped"

    def row_of_ref(ref: str) -> PlannedRow | None:
        i = identity.get(value_key(ref))
        return None if i is None else drafts[i]

    def warn(d: PlannedRow, fld: str, reason: str, value: str) -> None:
        d.issues.append({"severity": "warning", "field": fld, "reason": reason, "value": value})

    # pass 2: references, labels, sprints, epics, options (imported rows only)
    new_labels: list[str] = []
    new_epics: list[str] = []
    option_creates: dict[str, list[str]] = {}

    def add_new_epic(name: str) -> None:
        k = name.lower()
        if k not in epic_by_name and not any(e.lower() == k for e in new_epics):
            new_epics.append(name)

    label_cols = cols("labels")
    dep_cols = {"blockedBy": cols("blockedBy"), "blocks": cols("blocks")}
    for d in drafts:
        if not live(d):
            continue
        source_row = rows_in[d.row - 2]
        if d.is_epic:
            add_new_epic(d.values["title"])
            if bool(d.values["startDate"]) != bool(d.values["dueDate"]):
                warn(
                    d,
                    "startDate",
                    "Epic dates need both start and target · dates left empty",
                    d.values["startDate"] or d.values["dueDate"] or "",
                )
                d.values["startDate"] = d.values["dueDate"] = None
            continue
        # labels: split on ; and , · trimmed, lower-cased, cut to 24, de-duplicated, max 20
        raw_labels = [x for c in label_cols for x in _LIST_SPLIT.split(source_row[c] if c < len(source_row) else "")]
        names = list(dict.fromkeys(n for n in (x.strip().lower()[:MAX_LABEL] for x in raw_labels) if n))
        if len(names) > LIMITS["labels_per_task"]:
            warn(
                d, "labels", "More than 20 labels · extra labels dropped", ", ".join(names[LIMITS["labels_per_task"] :])
            )
        d.values["labels"] = names[: LIMITS["labels_per_task"]]
        for n in d.values["labels"]:
            if n not in label_names and n not in new_labels:
                new_labels.append(n)

        sprint_raw = cell(source_row, sprint_col)
        if sprint_raw:
            s = sprint_by_name.get(sprint_raw.lower())
            if s is not None:
                d.values["sprintId"] = str(s["id"])
            else:
                warn(d, "sprint", f"No sprint named “{sprint_raw}” · added to the backlog", sprint_raw)

        # epic: an epic row's ID, else an epic name (existing, new with epic.manage, or a warning)
        if d.epic_ref:
            ref_row = row_of_ref(d.epic_ref)
            if ref_row is not None and ref_row.is_epic and live(ref_row):
                d.epic_row = ref_row.row
                d.epic_name = ref_row.values["title"]
            else:
                existing = epic_by_name.get(d.epic_ref.lower())
                if existing is not None:
                    d.epic_id, d.epic_name = str(existing["id"]), existing["name"]
                elif can_epic:
                    d.epic_name = d.epic_ref
                    add_new_epic(d.epic_ref)
                else:
                    warn(d, "epic", f"No epic named “{d.epic_ref}” · left without an epic", d.epic_ref)

        # parent: a row of this file (epic row → the task's epic), else an existing task key
        if d.parent_ref:
            ref_row = row_of_ref(d.parent_ref)
            existing_task = None if ref_row is not None else existing_by_key.get(d.parent_ref.lower())
            if ref_row is not None and live(ref_row) and ref_row is not d:
                if ref_row.is_epic:
                    if d.epic_row is None and not d.epic_id and not d.epic_name:
                        d.epic_row = ref_row.row
                        d.epic_name = ref_row.values["title"]
                else:
                    d.parent = {"row": ref_row.row}
            elif existing_task is not None:
                if existing_task["parentId"]:
                    warn(d, "parent", "Parent is a sub-task · imported as a top-level task", d.parent_ref)
                else:
                    d.parent = {"taskId": str(existing_task["id"])}
            else:
                warn(d, "parent", f"Parent “{d.parent_ref}” not found · imported as a top-level task", d.parent_ref)

        # dependencies: references split on , ; and whitespace
        for fld in ("blockedBy", "blocks"):
            refs = [
                x.strip()
                for c in dep_cols[fld]
                for x in _REF_SPLIT.split(source_row[c] if c < len(source_row) else "")
                if x.strip()
            ]
            out_refs = d.blocked_by if fld == "blockedBy" else d.blocks
            for ref in refs:
                ref_row = row_of_ref(ref)
                existing_task = None if ref_row is not None else existing_by_key.get(ref.lower())
                if ref_row is not None and live(ref_row) and not ref_row.is_epic:
                    out_refs.append({"ref": ref, "row": ref_row.row})
                elif existing_task is not None:
                    out_refs.append({"ref": ref, "taskId": str(existing_task["id"])})
                else:
                    warn(d, fld, f"“{ref}” not found · dependency skipped", ref)

        # select options to create, or a warning
        for fid, name in list(d.new_options.items()):
            f = fields_by_id[fid]
            pending = option_creates.get(fid, [])
            known = any(x.lower() == name.lower() for x in pending)
            if can_options and (known or len(f["options"]) + len(pending) < LIMITS["options"]):
                if not known:
                    option_creates[fid] = [*pending, name]
            else:
                warn(d, "customField", f"{f['name']}: no option “{name}” · left empty", name)
                del d.new_options[fid]

    # pass 3: one-level parents, inheritance, numbering, preview values
    task_index = 0
    for d in drafts:
        if d.outcome != "task":
            continue
        if d.parent is not None and "row" in d.parent:
            p = drafts[d.parent["row"] - 2]
            if p.parent is not None:
                warn(d, "parent", "Parent is a sub-task · imported as a top-level task", d.parent_ref)
                d.parent = None
            else:
                # Sub-tasks inherit the parent's sprint, and its epic when they have none (v1).
                d.values["sprintId"] = p.values["sprintId"]
                if d.epic_row is None and not d.epic_id and not d.epic_name:
                    d.epic_row, d.epic_id, d.epic_name = p.epic_row, p.epic_id, p.epic_name
        elif d.parent is not None and "taskId" in d.parent:
            pt = tasks_by_id[d.parent["taskId"]]
            d.values["sprintId"] = str(pt["sprintId"]) if pt["sprintId"] else None
            if d.epic_row is None and not d.epic_id and not d.epic_name and pt["epicId"]:
                d.epic_id = str(pt["epicId"])
        d.task_index = task_index
        d.key = f"{project.key}-{project.task_seq + 1 + task_index}"
        task_index += 1
    epic_names = {str(e["id"]): e["name"] for e in project.epics}
    for d in drafts:
        if d.outcome == "skipped":
            continue
        if d.epic_id:
            d.values["epic"] = {"id": d.epic_id, "name": d.epic_name or epic_names.get(d.epic_id, "")}
        elif d.epic_name:
            d.values["epic"] = {"name": d.epic_name, "new": d.epic_name.lower() not in epic_by_name}
        else:
            d.values["epic"] = None
        if d.parent is not None and "row" in d.parent:
            d.values["parent"] = {"ref": d.parent_ref, "row": d.parent["row"]}
        elif d.parent is not None and "taskId" in d.parent:
            d.values["parent"] = {"ref": d.parent_ref, "taskId": d.parent["taskId"]}
        if d.outcome == "task":
            d.issues.sort(key=lambda x: 0 if x["severity"] == "skip" else 1)

    # validation
    tasks = sum(1 for d in drafts if d.outcome == "task")
    epics = sum(1 for d in drafts if d.outcome == "epic")
    skipped = sum(1 for d in drafts if d.outcome == "skipped")
    warnings = sum(1 for d in drafts for x in d.issues if x["severity"] == "warning")
    skip_reasons: list[dict[str, Any]] = []
    for d in drafts:
        s = next((x for x in d.issues if x["severity"] == "skip"), None)
        if s is None:
            continue
        hit = next((x for x in skip_reasons if x["reason"] == s["reason"]), None)
        if hit is not None:
            hit["count"] += 1
        else:
            skip_reasons.append({"reason": s["reason"], "count": 1})

    blockers: list[dict[str, Any]] = []
    if title_col < 0:
        blockers.append({"code": "title_unmapped", "message": "Map a column to Title", "field": "title"})
    seen: set[str] = set()
    for c in columns:
        col_field = c.get("field")
        if col_field in MULTI_COLUMN:
            continue
        k = f"cf:{c.get('customFieldId')}" if col_field == "customField" else str(col_field)
        if k in seen:
            label = (
                (fields_by_id.get(str(c.get("customFieldId"))) or {}).get("name", "a custom field")
                if col_field == "customField"
                else FIELD_LABELS[str(col_field)]
            )
            blockers.append({"code": "duplicate_field", "message": f"Two columns map to {label}", "field": col_field})
            break
        seen.add(k)
    unmapped_statuses = sum(1 for v in status_vals if not v["target"])
    if unmapped_statuses:
        msg = _more(unmapped_statuses, "status", "statuses")
        blockers.append({"code": "status_unmapped", "message": msg, "field": "status"})
    unmapped_types = sum(1 for v in type_vals if not v["target"])
    if unmapped_types:
        blockers.append({"code": "type_unmapped", "message": _more(unmapped_types, "type", "types"), "field": "type"})
    for vals, limit, label, fld in (
        (status_vals, LIMITS["statuses"], "statuses", "status"),
        (type_vals, LIMITS["types"], "types", "type"),
        (people_vals, LIMITS["people"], "people", "assignee"),
    ):
        if len(vals) > limit:
            msg = f"Too many {label} ({len(vals)} · max {limit})"
            blockers.append({"code": "too_many_values", "message": msg, "field": fld})
    if len(new_labels) > LIMITS["labels"]:
        msg = f"Too many new labels ({len(new_labels)} · max {LIMITS['labels']})"
        blockers.append({"code": "too_many_creates", "message": msg, "field": "labels"})
    epic_creates = new_epics if can_epic else []
    if len(epic_creates) > LIMITS["epics"]:
        msg = f"Too many new epics ({len(epic_creates)} · max {LIMITS['epics']})"
        blockers.append({"code": "too_many_creates", "message": msg, "field": "epic"})
    if tasks + epics == 0:
        blockers.append({"code": "nothing_to_import", "message": "No rows can be imported"})

    validation = {
        "ready": not blockers,
        "blockers": blockers,
        "values": {"statuses": status_vals, "types": type_vals, "people": people_vals},
        "counts": {
            "rows": len(drafts),
            "tasks": tasks,
            "epics": epics,
            "skipped": skipped,
            "warnings": warnings,
            "statuses": len(status_vals),
            "people": sum(1 for v in people_vals if v["target"]),
        },
        "skipReasons": skip_reasons,
        "creates": {
            "labels": new_labels,
            "epics": epic_creates,
            "options": [{"customFieldId": k, "names": v} for k, v in option_creates.items()] if can_options else [],
        },
        "keyRange": (
            {"first": f"{project.key}-{project.task_seq + 1}", "last": f"{project.key}-{project.task_seq + tasks}"}
            if tasks
            else None
        ),
    }
    mapping = {
        "revision": revision,
        "columns": columns,
        "statuses": {v["key"]: v["target"] for v in status_vals},
        "types": {v["key"]: v["target"] for v in type_vals},
        "people": {v["key"]: v["target"] for v in people_vals},
    }
    return PlanResult(validation=validation, rows=drafts, mapping=mapping)
