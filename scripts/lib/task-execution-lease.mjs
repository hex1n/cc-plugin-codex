const BREAKERS = Object.freeze({ max_turns: "turn_limit", max_budget: "cost_budget" });

export function createTaskExecutionLease({ maxTurns, finalizeAtTurn }) {
  assertPositiveInteger(maxTurns, "maxTurns");
  assertPositiveInteger(finalizeAtTurn, "finalizeAtTurn");
  if (finalizeAtTurn >= maxTurns) throw new Error("finalizeAtTurn must be lower than maxTurns");
  return {
    phase: "working",
    workingTurnLimit: finalizeAtTurn,
    hardTurnLimit: maxTurns,
    completionReserveTurns: maxTurns - finalizeAtTurn,
    revision: 0,
    checkpointCalls: 0,
    completionCalls: 0,
  };
}

export function checkpointFromBreaker({ lease, state, error, sessionId, now = new Date() }) {
  const reason = BREAKERS[error?.errorKind];
  if (!reason) return null;
  if (!sessionId || state?.phase !== "checkpointed" || !state.checkpoint) return null;
  return {
    status: "checkpointed",
    phase: "checkpointed",
    taskExecutionLease: projectTaskExecutionState(lease, state),
    taskCheckpoint: state.checkpoint,
    checkpointReason: reason,
    resumeEligible: true,
    checkpointedAt: now.toISOString(),
    suggestedAction: "resume_task_checkpoint",
  };
}

export function checkpointFromIncomplete({ lease, state, sessionId, now = new Date() }) {
  if (!sessionId || state?.phase !== "checkpointed" || !state.checkpoint) return null;
  return {
    status: "checkpointed",
    phase: "checkpointed",
    taskExecutionLease: projectTaskExecutionState(lease, state),
    taskCheckpoint: state.checkpoint,
    checkpointReason: "completion_missing",
    resumeEligible: true,
    checkpointedAt: now.toISOString(),
    suggestedAction: "resume_task_checkpoint",
  };
}

export function projectTaskExecutionState(lease, state) {
  return {
    ...lease,
    phase: state.phase,
    revision: state.revision,
    checkpointCalls: state.checkpointCalls,
    completionCalls: state.completionCalls,
  };
}

export function assertTaskResumeEligible(job) {
  if (!job?.taskExecutionLeaseEnabled) throw resumeError("Job does not use Task Execution Lease", "task_execution_lease_disabled");
  if (job.status !== "checkpointed" || !job.resumeEligible || job.resumedByJobId) throw resumeError("Task checkpoint is not resume eligible", "task_checkpoint_not_resumable");
  if (!job.sessionId || !job.taskCheckpoint) throw resumeError("Task checkpoint is missing its Claude session or receipt", "task_checkpoint_corrupt");
  return job;
}

export function linkTaskResumeChild(job, { claimId, childId, now = new Date() }) {
  if (job.resumeClaimId !== claimId) throw resumeError("Task resume claim changed before child linkage", "task_checkpoint_race");
  if (job.resumedByJobId && job.resumedByJobId !== childId) throw resumeError("Task resume claim is already linked to a different child", "task_checkpoint_race");
  if (job.resumedByJobId === childId) return job;
  return { ...job, resumedByJobId: childId, resumedAt: now.toISOString() };
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function resumeError(message, errorKind) { return Object.assign(new Error(message), { errorKind }); }
