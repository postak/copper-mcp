import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  copperFetch,
  copperFetchWithMeta,
  fetchPipelinesMap,
  fetchUsersMap,
  fetchAllOpportunities,
  mapOpportunity,
  resolveParentName,
} from "./copper.js";
import {
  jsonResult,
  errorResult,
  toUnixTimestamp,
  toISODate,
  parseStatusInput,
  toCopperCloseDate,
} from "./utils.js";

export function createServer() {
  const server = new McpServer({
    name: "copper-crm",
    version: "1.0.0",
  });

  server.tool(
    "search_people",
    "Search Copper contacts by name, email, or phone. Returns matching person records with IDs for use in create_activity.",
    {
      name: z.string().optional().describe("Full name or partial name to search"),
      emails: z.array(z.string()).optional().describe("Email addresses to match"),
      phone_number: z.string().optional().describe("Phone number to match"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ name, emails, phone_number, page_size, page_number }) => {
      const body = {};
      if (name) body.name = name;
      if (emails) body.emails = emails;
      if (phone_number) body.phone_number = phone_number;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;

      const results = await copperFetch("/people/search", { method: "POST", body });
      const people = results.map((p) => ({
        id: p.id,
        name: p.name,
        first_name: p.first_name,
        last_name: p.last_name,
        emails: p.emails,
        phone_numbers: p.phone_numbers,
        company_id: p.company_id,
        company_name: p.company_name,
        title: p.title,
      }));
      return jsonResult(people);
    }
  );

  server.tool(
    "get_person",
    "Get full details of a Copper contact by their ID.",
    { person_id: z.number().describe("Copper person ID") },
    async ({ person_id }) => jsonResult(await copperFetch(`/people/${person_id}`))
  );

  server.tool(
    "create_person",
    "Create a new person (contact) in Copper CRM.",
    {
      first_name: z.string().describe("First name"),
      last_name: z.string().describe("Last name"),
      title: z.string().optional().describe("Job title"),
      company_name: z.string().optional().describe("Company name (Copper auto-links or creates)"),
      emails: z.array(z.object({
        email: z.string(),
        category: z.enum(["work", "personal", "other"]).optional()
      })).optional().describe("Email addresses"),
      phone_numbers: z.array(z.object({
        number: z.string(),
        category: z.enum(["work", "mobile", "home", "other"]).optional()
      })).optional().describe("Phone numbers"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      contact_type_id: z.number().optional().describe("Contact type ID"),
    },
    async ({ first_name, last_name, title, company_name, emails, phone_numbers, tags, contact_type_id }) => {
      const body = { name: `${first_name} ${last_name}` };
      if (first_name) body.first_name = first_name;
      if (last_name) body.last_name = last_name;
      if (title) body.title = title;
      if (company_name) body.company_name = company_name;
      if (emails) body.emails = emails;
      if (phone_numbers) body.phone_numbers = phone_numbers;
      if (tags) body.tags = tags;
      if (contact_type_id) body.contact_type_id = contact_type_id;
      return jsonResult(await copperFetch("/people", { method: "POST", body }));
    }
  );

  server.tool(
    "update_person",
    "Update an existing person (contact) in Copper CRM. Only include fields you want to change. The 'details' field is the 'About' section visible at the top of the contact page.",
    {
      person_id: z.number().describe("Copper person ID to update"),
      details: z.string().optional().describe("About/details text (visible at top of contact page in Copper UI)"),
      title: z.string().optional().describe("Job title"),
      tags: z.array(z.string()).optional().describe("Tags (replaces existing tags)"),
    },
    async ({ person_id, details, title, tags }) => {
      const body = {};
      if (details !== undefined) body.details = details;
      if (title !== undefined) body.title = title;
      if (tags !== undefined) body.tags = tags;
      const result = await copperFetch(`/people/${person_id}`, { method: "PUT", body });
      return jsonResult({ id: result.id, name: result.name, details: result.details, title: result.title, tags: result.tags });
    }
  );

  server.tool(
    "search_companies",
    "Search Copper companies by name. Returns matching company records.",
    {
      name: z.string().optional().describe("Company name to search"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ name, page_size, page_number }) => {
      const body = {};
      if (name) body.name = name;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;
      const results = await copperFetch("/companies/search", { method: "POST", body });
      return jsonResult(results.map((c) => ({
        id: c.id,
        name: c.name,
        email_domain: c.email_domain,
        phone_numbers: c.phone_numbers,
        websites: c.websites,
        address: c.address,
      })));
    }
  );

  server.tool(
    "list_activity_types",
    "List all available activity types in Copper (e.g., Note, Meeting, Phone Call). Returns activity_type_id values needed for create_activity.",
    {},
    async () => jsonResult(await copperFetch("/activity_types"))
  );

  server.tool(
    "create_activity",
    "Log an activity (meeting note, phone call, etc.) against a Copper person or company. Use list_activity_types first to get the correct activity_type_id.",
    {
      parent_type: z.enum(["person", "company"]).describe("Type of record to log against"),
      parent_id: z.number().describe("Copper ID of the person or company"),
      activity_type_id: z.number().describe("Activity type ID (from list_activity_types)"),
      details: z.string().describe("Activity content — meeting notes, action items, summary, etc. Use plain text, not markdown."),
      activity_date: z.number().optional().describe("Unix timestamp for when the activity occurred (default: now)"),
    },
    async ({ parent_type, parent_id, activity_type_id, details, activity_date }) => {
      const body = {
        parent: { type: parent_type, id: parent_id },
        type: { id: activity_type_id, category: "user" },
        details,
      };
      if (activity_date) body.activity_date = activity_date;
      const result = await copperFetch("/activities", { method: "POST", body });
      return jsonResult({ id: result.id, parent: result.parent, type: result.type, details: result.details, activity_date: result.activity_date });
    }
  );

  server.tool(
    "list_opportunities",
    `Search Copper opportunities (deals). Returns enriched records with pipeline stage names, ISO dates, and pagination metadata.

FILTERS (all optional, combinable):
- name: partial text match on deal name
- status: human-readable ["Open","Won","Lost","Abandoned"] — preferred over status_ids
- status_ids: raw Copper IDs [0,1,2,3] — for revenue pipelines only (non-revenue: 0=Open,1=Done,2=Won't Do,3=On Hold)
- pipeline_name: resolve pipeline by name (case-insensitive) instead of pipeline_ids
- pipeline_ids: raw Copper pipeline IDs
- pipeline_stage_names: resolve stages by name (case-insensitive) within the specified pipeline(s)
- pipeline_stage_ids: raw Copper pipeline stage IDs
- company_ids, person_ids: filter by related entity IDs
- tags: filter by tags
- minimum_close_date, maximum_close_date: ISO 8601 ("2026-01-01") or Unix timestamp

RESPONSE: results[], total_count (upper bound from Copper), page, page_size, has_more.
Fields per deal: id, name, company_id, company_name, monetary_value, currency, status,
pipeline_id, pipeline_stage_id, pipeline_stage_name, owner_id, owner_name, win_probability,
close_date (ISO), created_at (ISO), updated_at (ISO), tags, won_reason, lost_reason.
Use fields[] to restrict returned fields and reduce response size.

SORT: sort_by is passed natively to Copper API. Values: "name", "monetary_value", "close_date",
"date_modified", "date_created", "inactive_days", "last_interaction", "stage", "status".
sort_direction: "asc" or "desc".`,
    {
      name: z.string().optional().describe("Opportunity name to search (partial match)"),
      company_ids: z.array(z.number()).optional().describe("Filter by company IDs"),
      person_ids: z.array(z.number()).optional().describe("Filter by associated person IDs"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
      status_ids: z.array(z.number()).optional().describe("Filter by status IDs (0=Open,1=Won,2=Lost,3=Abandoned for revenue pipelines). Prefer status[] with string names."),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      minimum_close_date: z.union([z.number(), z.string()]).optional().describe("Min close date: ISO 8601 string or Unix timestamp"),
      maximum_close_date: z.union([z.number(), z.string()]).optional().describe("Max close date: ISO 8601 string or Unix timestamp"),
      pipeline_stage_ids: z.array(z.number()).optional().describe("Filter by pipeline stage IDs (raw). Prefer pipeline_stage_names for readability."),
      pipeline_ids: z.array(z.number()).optional().describe("Filter by pipeline IDs (raw). Prefer pipeline_name for readability."),
      status: z.array(z.enum(["Open", "Won", "Lost", "Abandoned"])).optional()
        .describe("Filter by status names (revenue pipelines). Takes precedence over status_ids if both provided."),
      pipeline_name: z.string().optional()
        .describe("Filter by pipeline name (case-insensitive). Resolved to pipeline_id automatically."),
      pipeline_stage_names: z.array(z.string()).optional()
        .describe("Filter by stage names (case-insensitive). Specify pipeline_name or pipeline_ids to disambiguate across pipelines."),
      sort_by: z.enum(["name", "monetary_value", "close_date", "date_modified", "date_created", "inactive_days", "last_interaction", "stage", "status"]).optional()
        .describe("Field to sort by. Passed natively to Copper API (sorts full dataset, not just current page)."),
      sort_direction: z.enum(["asc", "desc"]).optional()
        .describe("Sort direction (default: asc). Used with sort_by."),
      fields: z.array(z.string()).optional()
        .describe("Subset of fields to return. If omitted, all fields are returned. Example: [\"id\",\"name\",\"monetary_value\",\"status\"]"),
    },
    async ({
      name, company_ids, person_ids, page_size, page_number,
      status_ids, tags, minimum_close_date, maximum_close_date,
      pipeline_stage_ids, pipeline_ids,
      status, pipeline_name, pipeline_stage_names,
      sort_by, sort_direction, fields,
    }) => {
      let resolvedPipelineIds = pipeline_ids;
      let pipelinesMap = null;

      if (pipeline_name || pipeline_stage_names) {
        pipelinesMap = await fetchPipelinesMap();
        if (pipeline_name) {
          const found = pipelinesMap.byName.get(pipeline_name.toLowerCase());
          if (!found) return errorResult(`Pipeline not found: "${pipeline_name}". Use list_pipelines to see available pipelines.`);
          resolvedPipelineIds = [found.id];
        }
      }

      let resolvedStageIds = pipeline_stage_ids;
      if (pipeline_stage_names && pipeline_stage_names.length > 0) {
        const stageIds = [];
        const searchIn = resolvedPipelineIds
          ? resolvedPipelineIds.map((id) => pipelinesMap.byId.get(id)).filter(Boolean)
          : [...pipelinesMap.byId.values()];
        for (const stageName of pipeline_stage_names) {
          let found = false;
          for (const p of searchIn) {
            const stageId = p.stagesByName.get(stageName.toLowerCase());
            if (stageId !== undefined) { stageIds.push(stageId); found = true; break; }
          }
          if (!found) return errorResult(`Stage not found: "${stageName}". Use list_pipelines to see available stages.`);
        }
        resolvedStageIds = stageIds;
      }

      const resolvedStatusIds = status && status.length > 0 ? parseStatusInput(status) : status_ids;

      const effectivePageSize = page_size || 20;
      const body = {};
      if (name) body.name = name;
      if (company_ids) body.company_ids = company_ids;
      if (person_ids) body.person_ids = person_ids;
      if (resolvedStatusIds) body.status_ids = resolvedStatusIds;
      if (tags) body.tags = tags;
      const minDate = toUnixTimestamp(minimum_close_date);
      const maxDate = toUnixTimestamp(maximum_close_date);
      if (minDate) body.minimum_close_date = minDate;
      if (maxDate) body.maximum_close_date = maxDate;
      if (resolvedStageIds) body.pipeline_stage_ids = resolvedStageIds;
      if (resolvedPipelineIds) body.pipeline_ids = resolvedPipelineIds;
      if (sort_by) body.sort_by = sort_by;
      if (sort_direction) body.sort_direction = sort_direction;
      body.page_size = effectivePageSize;
      body.page_number = page_number || 1;

      const { data: results, total_count } = await copperFetchWithMeta("/opportunities/search", { method: "POST", body });

      const [resolvedPipelinesMap, usersMap] = await Promise.all([
        pipelinesMap ? Promise.resolve(pipelinesMap) : fetchPipelinesMap(),
        fetchUsersMap(),
      ]);
      pipelinesMap = resolvedPipelinesMap;

      let mapped = results.map((o) => mapOpportunity(o, pipelinesMap.byId, usersMap));

      if (fields && fields.length > 0) {
        mapped = mapped.map((o) => {
          const proj = {};
          for (const f of fields) if (f in o) proj[f] = o[f];
          return proj;
        });
      }

      const currentPage = page_number || 1;
      const has_more = total_count !== null
        ? currentPage * effectivePageSize < total_count
        : results.length === effectivePageSize;

      return jsonResult({ results: mapped, total_count, page: currentPage, page_size: effectivePageSize, has_more });
    }
  );

  server.tool(
    "create_opportunity",
    "Create a new opportunity (deal/task) in Copper CRM.",
    {
      name: z.string().describe("The name of the opportunity"),
      pipeline_id: z.number().optional().describe("Copper pipeline ID"),
      pipeline_name: z.string().optional().describe("Case-insensitive pipeline name (used to resolve pipeline_id)"),
      pipeline_stage_id: z.number().optional().describe("Copper stage ID within the pipeline"),
      pipeline_stage_name: z.string().optional().describe("Case-insensitive stage name within the selected pipeline (used to resolve pipeline_stage_id)"),
      primary_contact_id: z.number().optional().describe("Copper ID of the primary contact person"),
      company_id: z.number().optional().describe("Copper ID of the associated company"),
      monetary_value: z.number().optional().describe("Monetary value of the opportunity"),
      win_probability: z.number().optional().describe("Win probability (0 to 100)"),
      close_date: z.union([z.number(), z.string()]).optional().describe("Expected close date. Can be ISO string (YYYY-MM-DD), MM/DD/YYYY, or Unix timestamp (seconds or milliseconds)"),
      owner_id: z.number().optional().describe("Copper ID of the user owning the opportunity"),
      tags: z.array(z.string()).optional().describe("Tags for the opportunity"),
      details: z.string().optional().describe("Description / details of the opportunity"),
      status: z.enum(["Open", "Won", "Lost", "Abandoned"]).optional().describe("Status of the opportunity"),
      priority: z.enum(["None", "Low", "Medium", "High"]).optional().describe("Priority level of the opportunity"),
    },
    async ({
      name, pipeline_id, pipeline_name, pipeline_stage_id, pipeline_stage_name,
      primary_contact_id, company_id, monetary_value, win_probability,
      close_date, owner_id, tags, details, status, priority
    }) => {
      let resolvedPipelineId = pipeline_id;
      let pipelinesMap = null;

      if (pipeline_name || pipeline_stage_name) {
        pipelinesMap = await fetchPipelinesMap();
        if (pipeline_name) {
          const found = pipelinesMap.byName.get(pipeline_name.toLowerCase());
          if (!found) return errorResult(`Pipeline not found: "${pipeline_name}". Use list_pipelines to see available pipelines.`);
          resolvedPipelineId = found.id;
        }
      }

      let resolvedStageId = pipeline_stage_id;
      if (pipeline_stage_name) {
        if (!pipelinesMap) {
          pipelinesMap = await fetchPipelinesMap();
        }
        const searchIn = resolvedPipelineId
          ? [pipelinesMap.byId.get(resolvedPipelineId)].filter(Boolean)
          : [...pipelinesMap.byId.values()];
        
        let foundStageId = null;
        for (const p of searchIn) {
          const stageId = p.stagesByName.get(pipeline_stage_name.toLowerCase());
          if (stageId !== undefined) {
            foundStageId = stageId;
            if (!resolvedPipelineId) {
              resolvedPipelineId = p.id;
            }
            break;
          }
        }
        if (foundStageId === null) {
          return errorResult(`Stage not found: "${pipeline_stage_name}". Use list_pipelines to see available stages.`);
        }
        resolvedStageId = foundStageId;
      }

      const body = { name };
      if (resolvedPipelineId !== undefined) body.pipeline_id = resolvedPipelineId;
      if (resolvedStageId !== undefined) body.pipeline_stage_id = resolvedStageId;
      if (primary_contact_id !== undefined) body.primary_contact_id = primary_contact_id;
      if (company_id !== undefined) body.company_id = company_id;
      if (monetary_value !== undefined) body.monetary_value = monetary_value;
      if (win_probability !== undefined) body.win_probability = win_probability;
      if (owner_id !== undefined) body.assignee_id = owner_id;
      if (tags !== undefined) body.tags = tags;
      if (details !== undefined) body.details = details;
      if (status !== undefined) body.status = status;
      if (priority !== undefined) body.priority = priority;

      if (close_date !== undefined) {
        const formattedCloseDate = toCopperCloseDate(close_date);
        if (formattedCloseDate) {
          body.close_date = formattedCloseDate;
        }
      }

      const result = await copperFetch("/opportunities", { method: "POST", body });

      const [resolvedPipelinesMap, usersMap] = await Promise.all([
        pipelinesMap ? Promise.resolve(pipelinesMap) : fetchPipelinesMap(),
        fetchUsersMap(),
      ]);

      return jsonResult(mapOpportunity(result, resolvedPipelinesMap.byId, usersMap));
    }
  );

  server.tool(
    "update_opportunity",
    "Update an existing opportunity (deal/task) in Copper CRM. Only include fields you want to change.",
    {
      opportunity_id: z.number().describe("The Copper opportunity ID to update"),
      name: z.string().optional().describe("The name of the opportunity"),
      pipeline_id: z.number().optional().describe("Copper pipeline ID"),
      pipeline_name: z.string().optional().describe("Case-insensitive pipeline name (used to resolve pipeline_id)"),
      pipeline_stage_id: z.number().optional().describe("Copper stage ID within the pipeline"),
      pipeline_stage_name: z.string().optional().describe("Case-insensitive stage name within the selected pipeline (used to resolve pipeline_stage_id)"),
      primary_contact_id: z.number().optional().nullable().describe("Copper ID of the primary contact person. Set to null to clear."),
      company_id: z.number().optional().nullable().describe("Copper ID of the associated company. Set to null to clear."),
      monetary_value: z.number().optional().nullable().describe("Monetary value of the opportunity. Set to null to clear."),
      win_probability: z.number().optional().nullable().describe("Win probability (0 to 100). Set to null to clear."),
      close_date: z.union([z.number(), z.string(), z.null()]).optional().describe("Expected close date. Can be ISO string (YYYY-MM-DD), MM/DD/YYYY, or Unix timestamp (seconds or milliseconds). Set to null to clear."),
      owner_id: z.number().optional().nullable().describe("Copper ID of the user owning the opportunity. Set to null to clear."),
      tags: z.array(z.string()).optional().describe("Tags for the opportunity"),
      details: z.string().optional().nullable().describe("Description / details of the opportunity. Set to null to clear."),
      status: z.enum(["Open", "Won", "Lost", "Abandoned"]).optional().describe("Status of the opportunity"),
      priority: z.enum(["None", "Low", "Medium", "High"]).optional().describe("Priority level of the opportunity"),
    },
    async ({
      opportunity_id, name, pipeline_id, pipeline_name, pipeline_stage_id, pipeline_stage_name,
      primary_contact_id, company_id, monetary_value, win_probability,
      close_date, owner_id, tags, details, status, priority
    }) => {
      let resolvedPipelineId = pipeline_id;
      let pipelinesMap = null;

      if (pipeline_name || pipeline_stage_name) {
        pipelinesMap = await fetchPipelinesMap();
        if (pipeline_name) {
          const found = pipelinesMap.byName.get(pipeline_name.toLowerCase());
          if (!found) return errorResult(`Pipeline not found: "${pipeline_name}". Use list_pipelines to see available pipelines.`);
          resolvedPipelineId = found.id;
        }
      }

      let resolvedStageId = pipeline_stage_id;
      if (pipeline_stage_name) {
        if (!pipelinesMap) {
          pipelinesMap = await fetchPipelinesMap();
        }
        const searchIn = resolvedPipelineId
          ? [pipelinesMap.byId.get(resolvedPipelineId)].filter(Boolean)
          : [...pipelinesMap.byId.values()];
        
        let foundStageId = null;
        for (const p of searchIn) {
          const stageId = p.stagesByName.get(pipeline_stage_name.toLowerCase());
          if (stageId !== undefined) {
            foundStageId = stageId;
            if (!resolvedPipelineId) {
              resolvedPipelineId = p.id;
            }
            break;
          }
        }
        if (foundStageId === null) {
          return errorResult(`Stage not found: "${pipeline_stage_name}". Use list_pipelines to see available stages.`);
        }
        resolvedStageId = foundStageId;
      }

      const body = {};
      if (name !== undefined) body.name = name;
      if (resolvedPipelineId !== undefined) body.pipeline_id = resolvedPipelineId;
      if (resolvedStageId !== undefined) body.pipeline_stage_id = resolvedStageId;
      if (primary_contact_id !== undefined) body.primary_contact_id = primary_contact_id;
      if (company_id !== undefined) body.company_id = company_id;
      if (monetary_value !== undefined) body.monetary_value = monetary_value;
      if (win_probability !== undefined) body.win_probability = win_probability;
      if (owner_id !== undefined) body.assignee_id = owner_id;
      if (tags !== undefined) body.tags = tags;
      if (details !== undefined) body.details = details;
      if (status !== undefined) body.status = status;
      if (priority !== undefined) body.priority = priority;

      if (close_date !== undefined) {
        if (close_date === null) {
          body.close_date = null;
        } else {
          const formattedCloseDate = toCopperCloseDate(close_date);
          if (formattedCloseDate) {
            body.close_date = formattedCloseDate;
          }
        }
      }

      const result = await copperFetch(`/opportunities/${opportunity_id}`, { method: "PUT", body });

      const [resolvedPipelinesMap, usersMap] = await Promise.all([
        pipelinesMap ? Promise.resolve(pipelinesMap) : fetchPipelinesMap(),
        fetchUsersMap(),
      ]);

      return jsonResult(mapOpportunity(result, resolvedPipelinesMap.byId, usersMap));
    }
  );

  server.tool(
    "summarize_opportunities",
    `Aggregate opportunities by a grouping dimension. Fetches ALL pages from Copper (full dataset) and aggregates client-side.
Useful for: pipeline health checks, funnel summaries, forecast totals, team performance by owner.

group_by options:
- "pipeline_stage_id": breakdown by pipeline stage (default)
- "status": breakdown by deal status (Open/Won/Lost/Abandoned)
- "owner_id": breakdown by deal owner/assignee

Accepts the same filters as list_opportunities (pipeline_name, status, minimum_close_date, etc.).
Returns totals and per-group counts with open/won/lost values and win-probability-weighted value.`,
    {
      group_by: z.enum(["pipeline_stage_id", "status", "owner_id"]).optional()
        .describe("Dimension to aggregate by (default: pipeline_stage_id)"),
      pipeline_ids: z.array(z.number()).optional().describe("Filter by pipeline IDs"),
      pipeline_name: z.string().optional().describe("Filter by pipeline name (case-insensitive)"),
      status_ids: z.array(z.number()).optional().describe("Filter by status IDs"),
      status: z.array(z.enum(["Open", "Won", "Lost", "Abandoned"])).optional().describe("Filter by status names"),
      company_ids: z.array(z.number()).optional().describe("Filter by company IDs"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      minimum_close_date: z.union([z.number(), z.string()]).optional().describe("Min close date: ISO 8601 or Unix timestamp"),
      maximum_close_date: z.union([z.number(), z.string()]).optional().describe("Max close date: ISO 8601 or Unix timestamp"),
    },
    async ({ group_by = "pipeline_stage_id", pipeline_ids, pipeline_name, status_ids, status, company_ids, tags, minimum_close_date, maximum_close_date }) => {
      const [pipelinesMap, usersMap] = await Promise.all([
        fetchPipelinesMap(),
        group_by === "owner_id" ? fetchUsersMap() : Promise.resolve(null),
      ]);
      let resolvedPipelineIds = pipeline_ids;
      if (pipeline_name) {
        const found = pipelinesMap.byName.get(pipeline_name.toLowerCase());
        if (!found) return errorResult(`Pipeline not found: "${pipeline_name}". Use list_pipelines to see available pipelines.`);
        resolvedPipelineIds = [found.id];
      }

      const resolvedStatusIds = status && status.length > 0 ? parseStatusInput(status) : status_ids;

      const filterBody = {};
      if (resolvedPipelineIds) filterBody.pipeline_ids = resolvedPipelineIds;
      if (resolvedStatusIds) filterBody.status_ids = resolvedStatusIds;
      if (company_ids) filterBody.company_ids = company_ids;
      if (tags) filterBody.tags = tags;
      const minDate = toUnixTimestamp(minimum_close_date);
      const maxDate = toUnixTimestamp(maximum_close_date);
      if (minDate) filterBody.minimum_close_date = minDate;
      if (maxDate) filterBody.maximum_close_date = maxDate;

      const allOpportunities = await fetchAllOpportunities(filterBody);

      const pipelineName = resolvedPipelineIds?.length === 1
        ? pipelinesMap.byId.get(resolvedPipelineIds[0])?.name ?? null
        : null;

      const STATUS_LABELS = { 0: "Open", 1: "Won", 2: "Lost", 3: "Abandoned" };
      const groups = new Map();

      for (const o of allOpportunities) {
        let key, label;
        if (group_by === "pipeline_stage_id") {
          key = o.pipeline_stage_id ?? "none";
          const stage = pipelinesMap.byId.get(o.pipeline_id)?.stagesById.get(o.pipeline_stage_id);
          label = stage?.name ?? `Stage ${key}`;
        } else if (group_by === "status") {
          key = o.status ?? "unknown";
          label = STATUS_LABELS[key] ?? `Status ${key}`;
        } else {
          key = o.assignee_id ?? o.owner_id ?? "unassigned";
          label = key === "unassigned" ? "Unassigned" : (usersMap?.get(key)?.name ?? `Owner ${key}`);
        }

        if (!groups.has(key)) {
          groups.set(key, { key, label, count: 0, value_open: 0, value_won: 0, value_lost: 0, value_abandoned: 0, weighted_value: 0 });
        }
        const g = groups.get(key);
        const val = o.monetary_value || 0;
        const stageWinProb = pipelinesMap.byId.get(o.pipeline_id)?.stagesById.get(o.pipeline_stage_id)?.win_probability ?? 0;
        const prob = o.win_probability ?? stageWinProb;
        g.count++;
        g.weighted_value += val * (prob / 100);
        const s = o.status;
        if (s === 0 || s === "Open") g.value_open += val;
        else if (s === 1 || s === "Won") g.value_won += val;
        else if (s === 2 || s === "Lost") g.value_lost += val;
        else if (s === 3 || s === "Abandoned") g.value_abandoned += val;
      }

      const groupsArr = [...groups.values()].map((g) => ({
        ...g,
        value_total: g.value_open + g.value_won + g.value_lost + g.value_abandoned,
        weighted_value: Math.round(g.weighted_value * 100) / 100,
      }));

      const totals = groupsArr.reduce((acc, g) => ({
        count: acc.count + g.count,
        value_total: acc.value_total + g.value_total,
        value_open: acc.value_open + g.value_open,
        value_won: acc.value_won + g.value_won,
        value_lost: acc.value_lost + g.value_lost,
        value_abandoned: acc.value_abandoned + g.value_abandoned,
        weighted_value: Math.round((acc.weighted_value + g.weighted_value) * 100) / 100,
      }), { count: 0, value_total: 0, value_open: 0, value_won: 0, value_lost: 0, value_abandoned: 0, weighted_value: 0 });

      return jsonResult({ pipeline_name: pipelineName, group_by, total_fetched: allOpportunities.length, totals, groups: groupsArr });
    }
  );

  server.tool(
    "get_pipeline_funnel",
    `Visualize a sales funnel for a specific pipeline. Fetches all opportunities and aggregates by stage.
Requires pipeline_id or pipeline_name. Returns per-stage metrics (count, value, weighted value) and a YTD summary with won/lost totals.
Useful for: weekly pipeline reviews, forecast presentations, funnel health checks.
NOTE: won_ytd/lost_ytd in summary refer to the current calendar year (Jan 1 to today), regardless of date filters applied to open deals.`,
    {
      pipeline_id: z.number().optional().describe("Copper pipeline ID"),
      pipeline_name: z.string().optional().describe("Pipeline name (case-insensitive alternative to pipeline_id)"),
      include_closed: z.boolean().optional().describe("Include Won/Lost deals in stage counts (default: false, only Open)"),
      close_date_from: z.union([z.number(), z.string()]).optional()
        .describe("Filter open deals by minimum close date: ISO 8601 or Unix timestamp. If omitted, includes all open deals regardless of close date."),
      close_date_to: z.union([z.number(), z.string()]).optional()
        .describe("Filter open deals by maximum close date: ISO 8601 or Unix timestamp."),
    },
    async ({ pipeline_id, pipeline_name, include_closed = false, close_date_from, close_date_to }) => {
      const pipelinesMap = await fetchPipelinesMap();
      let targetPipeline;
      if (pipeline_id) {
        targetPipeline = pipelinesMap.byId.get(pipeline_id);
      } else if (pipeline_name) {
        targetPipeline = pipelinesMap.byName.get(pipeline_name.toLowerCase());
      }
      if (!targetPipeline) return errorResult("Pipeline not found. Use list_pipelines to see available pipelines.");

      const filterBody = { pipeline_ids: [targetPipeline.id] };
      if (!include_closed) filterBody.status_ids = [0];
      const minDate = toUnixTimestamp(close_date_from);
      const maxDate = toUnixTimestamp(close_date_to);
      if (minDate) filterBody.minimum_close_date = minDate;
      if (maxDate) filterBody.maximum_close_date = maxDate;
      const allOpps = await fetchAllOpportunities(filterBody);

      const now = Math.floor(Date.now() / 1000);
      const startOfYear = Math.floor(new Date(`${new Date().getFullYear()}-01-01T00:00:00Z`).getTime() / 1000);
      const [wonYtd, lostYtd] = await Promise.all([
        fetchAllOpportunities({ pipeline_ids: [targetPipeline.id], status_ids: [1], minimum_close_date: startOfYear, maximum_close_date: now }),
        fetchAllOpportunities({ pipeline_ids: [targetPipeline.id], status_ids: [2], minimum_close_date: startOfYear, maximum_close_date: now }),
      ]);

      const stageMetrics = new Map();
      for (const [stageId, stageInfo] of targetPipeline.stagesById) {
        stageMetrics.set(stageId, { stage_id: stageId, stage_name: stageInfo.name, win_probability: stageInfo.win_probability, count: 0, value: 0, weighted_value: 0 });
      }

      for (const o of allOpps) {
        const m = stageMetrics.get(o.pipeline_stage_id);
        if (!m) continue;
        m.count++;
        m.value += o.monetary_value || 0;
        m.weighted_value += (o.monetary_value || 0) * ((o.win_probability ?? m.win_probability ?? 0) / 100);
      }

      const stages = [...stageMetrics.values()].map((m) => ({ ...m, weighted_value: Math.round(m.weighted_value * 100) / 100 }));

      const summary = {
        total_count: allOpps.length,
        total_value: stages.reduce((s, m) => s + m.value, 0),
        total_weighted_value: Math.round(stages.reduce((s, m) => s + m.weighted_value, 0) * 100) / 100,
        won_ytd_count: wonYtd.length,
        won_ytd_value: wonYtd.reduce((s, o) => s + (o.monetary_value || 0), 0),
        lost_ytd_count: lostYtd.length,
        lost_ytd_value: lostYtd.reduce((s, o) => s + (o.monetary_value || 0), 0),
      };

      return jsonResult({ pipeline_id: targetPipeline.id, pipeline_name: targetPipeline.name, stages, summary });
    }
  );

  server.tool(
    "get_stale_opportunities",
    `Find open opportunities with no recent updates. Uses Copper's native date_modified filter (maximum_modified_date) for server-side filtering — no full dataset download required.
NOTE: Staleness is based on date_modified (last record update), not last logged activity. For exact last-activity data, use list_activities filtered by opportunity.

Returns open deals not updated in the last N days, sorted by inactivity (most stale first).`,
    {
      days_since_update: z.number().optional().describe("Deals not updated in this many days (default: 30)"),
      pipeline_id: z.number().optional().describe("Filter by pipeline ID"),
      pipeline_name: z.string().optional().describe("Filter by pipeline name (case-insensitive)"),
      min_value: z.number().optional().describe("Minimum deal monetary value to include"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ days_since_update = 30, pipeline_id, pipeline_name, min_value, page_size = 20, page_number = 1 }) => {
      let resolvedPipelineId = pipeline_id;
      if (pipeline_name) {
        const pipelinesMap = await fetchPipelinesMap();
        const found = pipelinesMap.byName.get(pipeline_name.toLowerCase());
        if (!found) return errorResult(`Pipeline not found: "${pipeline_name}". Use list_pipelines.`);
        resolvedPipelineId = found.id;
      }

      const cutoffTs = Math.floor(Date.now() / 1000) - days_since_update * 86400;
      const body = {
        status_ids: [0],
        maximum_modified_date: cutoffTs,
        sort_by: "inactive_days",
        sort_direction: "desc",
        page_size,
        page_number,
      };
      if (resolvedPipelineId) body.pipeline_ids = [resolvedPipelineId];
      if (min_value !== undefined) body.minimum_monetary_value = min_value;

      const { data: results, total_count } = await copperFetchWithMeta("/opportunities/search", { method: "POST", body });

      const [pipelinesMap, usersMap] = await Promise.all([fetchPipelinesMap(), fetchUsersMap()]);
      const mapped = results.map((o) => {
        const ownerId = o.assignee_id ?? o.owner_id ?? null;
        return {
          id: o.id,
          name: o.name,
          company_name: o.company_name,
          monetary_value: o.monetary_value,
          pipeline_stage_name: pipelinesMap.byId.get(o.pipeline_id)?.stagesById.get(o.pipeline_stage_id)?.name ?? null,
          close_date: toISODate(o.close_date),
          updated_at: toISODate(o.date_modified),
          days_since_update: o.date_modified ? Math.floor((Date.now() / 1000 - o.date_modified) / 86400) : null,
          owner_id: ownerId,
          owner_name: ownerId ? (usersMap.get(ownerId)?.name ?? null) : null,
        };
      });

      const currentPage = page_number;
      const has_more = total_count !== null
        ? currentPage * page_size < total_count
        : results.length === page_size;

      return jsonResult({ results: mapped, total_count, page: currentPage, page_size, has_more, cutoff_date: toISODate(cutoffTs), days_since_update });
    }
  );

  server.tool(
    "list_activities",
    "Search Copper activities (meeting notes, calls, emails logged against contacts). Filter by parent record, activity type, or date range. Returns resolved parent names. Excludes system activities (assignee/status changes) by default.",
    {
      parent_type: z.enum(["person", "company", "lead", "opportunity", "project", "task"]).optional().describe("Filter by parent entity type"),
      parent_id: z.number().optional().describe("Filter by parent entity ID (requires parent_type)"),
      minimum_activity_date: z.number().optional().describe("Unix timestamp — only activities on or after this date"),
      maximum_activity_date: z.number().optional().describe("Unix timestamp — only activities on or before this date"),
      include_system: z.boolean().optional().describe("Include system activities like assignee/status changes (default: false)"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ parent_type, parent_id, minimum_activity_date, maximum_activity_date, include_system, page_size, page_number }) => {
      const body = {};
      if (parent_type && parent_id) body.parent = { id: parent_id, type: parent_type };
      if (minimum_activity_date) body.minimum_activity_date = minimum_activity_date;
      if (maximum_activity_date) body.maximum_activity_date = maximum_activity_date;
      body.page_size = page_size || 200;
      body.page_number = page_number || 1;

      const results = await copperFetch("/activities/search", { method: "POST", body });
      const filtered = include_system ? results : results.filter((a) => a.type?.category === "user");
      const nameCache = new Map();
      const activities = await Promise.all(
        filtered.map(async (a) => {
          const parentType = a.parent?.type;
          const parentId = a.parent?.id;
          const parent_name = parentType && parentId
            ? await resolveParentName(parentType, parentId, nameCache)
            : null;
          return { id: a.id, parent: a.parent, parent_name, type: a.type, user_id: a.user_id, details: a.details, activity_date: a.activity_date, date_created: a.date_created, date_modified: a.date_modified };
        })
      );
      return jsonResult(activities);
    }
  );

  server.tool(
    "list_users",
    "List all Copper CRM users. Returns user IDs, names, and emails. Useful for resolving owner_id to owner_name when building filters or displaying deal ownership.",
    {},
    async () => {
      const usersMap = await fetchUsersMap();
      return jsonResult([...usersMap.values()]);
    }
  );

  server.tool(
    "list_pipelines",
    "List all pipelines in Copper CRM. Returns pipeline IDs, names, and their stages — useful for filtering opportunities by pipeline_id or pipeline_stage_id.",
    {},
    async () => jsonResult(await copperFetch("/pipelines"))
  );

  const importPeopleHandler = async ({ people }) => {
    try {
      const payload = people.map((p) => {
        const item = {};
        if (p.name) {
          item.name = p.name;
        } else if (p.first_name || p.last_name) {
          item.name = [p.first_name, p.last_name].filter(Boolean).join(" ");
        }
        if (p.first_name) item.first_name = p.first_name;
        if (p.last_name) item.last_name = p.last_name;
        if (p.title) item.title = p.title;
        if (p.company_name) item.company_name = p.company_name;
        if (p.company_id) item.company_id = p.company_id;
        if (p.emails) item.emails = p.emails;
        if (p.phone_numbers) item.phone_numbers = p.phone_numbers;
        if (p.tags) item.tags = p.tags;
        if (p.contact_type_id) item.contact_type_id = p.contact_type_id;
        if (p.details) item.details = p.details;
        return item;
      });

      console.log(`[import_people] Starting import of ${payload.length} people...`);
      let results;
      try {
        console.log(`[import_people] Trying primary bulk endpoint with wrapped root key 'people': /people/bulk_create`);
        results = await copperFetch("/people/bulk_create", { method: "POST", body: { people: payload } });
        console.log(`[import_people] Primary bulk endpoint succeeded.`);
      } catch (err) {
        console.warn(`[import_people] Primary bulk endpoint failed: ${err.message}. Trying secondary bulk endpoint with wrapped root key 'people': /people/bulk/create...`);
        try {
          results = await copperFetch("/people/bulk/create", { method: "POST", body: { people: payload } });
          console.log(`[import_people] Secondary bulk endpoint succeeded.`);
        } catch (err2) {
          console.warn(`[import_people] Secondary bulk endpoint failed: ${err2.message}. Falling back to resilient individual single creations...`);
          results = [];
          for (const item of payload) {
            console.log(`[import_people] Resiliently creating person: ${item.name || "Unnamed"}`);
            try {
              const res = await copperFetch("/people", { method: "POST", body: item });
              results.push(res);
            } catch (errFallback) {
              console.error(`[import_people] Fallback creation failed for person "${item.name || "Unnamed"}":`, errFallback);
              results.push({ error: errFallback.message, record: item });
            }
          }
          console.log(`[import_people] Individual fallback complete.`);
        }
      }
      return jsonResult(results);
    } catch (err) {
      console.error(`[import_people] Error occurred during import:`, err);
      return errorResult(`Error in import_people: ${err.message}`);
    }
  };

  const importCompanyHandler = async ({ companies }) => {
    try {
      const payload = companies.map((c) => {
        const item = { name: c.name };
        if (c.details) item.details = c.details;
        if (c.email_domain) item.email_domain = c.email_domain;
        if (c.address) item.address = c.address;
        if (c.phone_numbers) item.phone_numbers = c.phone_numbers;
        if (c.websites) item.websites = c.websites;
        if (c.tags) item.tags = c.tags;
        return item;
      });

      console.log(`[import_companies] Starting import of ${payload.length} companies...`);
      let results;
      try {
        console.log(`[import_companies] Trying primary bulk endpoint with wrapped root key 'companies': /companies/bulk_create`);
        results = await copperFetch("/companies/bulk_create", { method: "POST", body: { companies: payload } });
        console.log(`[import_companies] Primary bulk endpoint succeeded.`);
      } catch (err) {
        console.warn(`[import_companies] Primary bulk endpoint failed: ${err.message}. Trying secondary bulk endpoint with wrapped root key 'companies': /companies/bulk/create...`);
        try {
          results = await copperFetch("/companies/bulk/create", { method: "POST", body: { companies: payload } });
          console.log(`[import_companies] Secondary bulk endpoint succeeded.`);
        } catch (err2) {
          console.warn(`[import_companies] Secondary bulk endpoint failed: ${err2.message}. Falling back to resilient individual single creations...`);
          results = [];
          for (const item of payload) {
            console.log(`[import_companies] Resiliently creating company: ${item.name}`);
            try {
              const res = await copperFetch("/companies", { method: "POST", body: item });
              results.push(res);
            } catch (errFallback) {
              console.error(`[import_companies] Fallback creation failed for company "${item.name}":`, errFallback);
              results.push({ error: errFallback.message, record: item });
            }
          }
          console.log(`[import_companies] Individual fallback complete.`);
        }
      }
      return jsonResult(results);
    } catch (err) {
      console.error(`[import_companies] Error occurred during import:`, err);
      return errorResult(`Error in import_companies: ${err.message}`);
    }
  };

  server.tool(
    "import_people",
    "Bulk import multiple people (contacts) into Copper CRM in a single request.",
    {
      people: z.array(z.object({
        first_name: z.string().optional().describe("First name"),
        last_name: z.string().optional().describe("Last name"),
        name: z.string().optional().describe("Full name (alternative to first_name/last_name)"),
        title: z.string().optional().describe("Job title"),
        company_name: z.string().optional().describe("Company name"),
        company_id: z.number().optional().describe("Company ID (if already exists)"),
        emails: z.array(z.object({
          email: z.string(),
          category: z.enum(["work", "personal", "other"]).optional()
        })).optional().describe("Email addresses"),
        phone_numbers: z.array(z.object({
          number: z.string(),
          category: z.enum(["work", "mobile", "home", "other"]).optional()
        })).optional().describe("Phone numbers"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
        contact_type_id: z.number().optional().describe("Contact type ID"),
        details: z.string().optional().describe("About/details description")
      })).describe("Array of people to import")
    },
    importPeopleHandler
  );

  server.tool(
    "import_companies",
    "Bulk import multiple companies into Copper CRM in a single request.",
    {
      companies: z.array(z.object({
        name: z.string().describe("Company name"),
        details: z.string().optional().describe("About/details description"),
        email_domain: z.string().optional().describe("Company email domain"),
        address: z.object({
          street: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postal_code: z.string().optional(),
          country: z.string().optional()
        }).optional().describe("Company physical address"),
        phone_numbers: z.array(z.object({
          number: z.string(),
          category: z.enum(["work", "other"]).optional()
        })).optional().describe("Phone numbers"),
        websites: z.array(z.object({
          url: z.string(),
          category: z.enum(["work", "personal", "other"]).optional()
        })).optional().describe("Websites"),
        tags: z.array(z.string()).optional().describe("Tags for categorization")
      })).describe("Array of companies to import")
    },
    importCompanyHandler
  );

  server.tool(
    "import_company",
    "Bulk import multiple companies into Copper CRM in a single request (singular alias).",
    {
      companies: z.array(z.object({
        name: z.string().describe("Company name"),
        details: z.string().optional().describe("About/details description"),
        email_domain: z.string().optional().describe("Company email domain"),
        address: z.object({
          street: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          postal_code: z.string().optional(),
          country: z.string().optional()
        }).optional().describe("Company physical address"),
        phone_numbers: z.array(z.object({
          number: z.string(),
          category: z.enum(["work", "other"]).optional()
        })).optional().describe("Phone numbers"),
        websites: z.array(z.object({
          url: z.string(),
          category: z.enum(["work", "personal", "other"]).optional()
        })).optional().describe("Websites"),
        tags: z.array(z.string()).optional().describe("Tags for categorization")
      })).describe("Array of companies to import")
    },
    importCompanyHandler
  );

  return server;
}
