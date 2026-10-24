function bucketLeadItems(items) {
  const buckets = {
    assign_owner: [],
    assign_reviewer: [],
    clarify_with_lead: [],
    repair_dependencies: [],
    lead_owned: [],
  };

  for (const item of items) {
    if (item.nextAction === 'assign_owner') {
      buckets.assign_owner.push(item);
      continue;
    }
    if (item.nextAction === 'assign_reviewer') {
      buckets.assign_reviewer.push(item);
      continue;
    }
    if (item.nextAction === 'clarify_with_lead') {
      buckets.clarify_with_lead.push(item);
      continue;
    }
    if (item.nextAction === 'repair_dependencies') {
      buckets.repair_dependencies.push(item);
      continue;
    }
    buckets.lead_owned.push(item);
  }

  return buckets;
}

module.exports = { bucketLeadItems };
