import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getResults,
  type ResultArtifactView,
  type ResultEvidenceView,
  type ResultView,
} from '../../services/project-api.js';

const label = (value: string) =>
  value
    .replaceAll('_', ' ')
    .toLocaleLowerCase('en-US')
    .replace(/^./u, (character) => character.toLocaleUpperCase('en-US'));

function latestVerificationDecision(view: ResultView): ResultView['audit'][number] | undefined {
  return [...view.audit].reverse().find(({ action }) => action === 'verification.decided');
}

function verificationState(view: ResultView): string {
  const decision = latestVerificationDecision(view);
  if (view.task.state === 'VERIFYING' && decision?.outcome === 'STALE') {
    return 'Stale · reevaluation required';
  }
  if (view.task.state === 'CLAIMED_COMPLETE') return 'Claimed complete';
  return label(view.task.state);
}

function latestArtifact(view: ResultView): ResultArtifactView | undefined {
  return view.artifacts.at(-1);
}

function integrityEvidence(view: ResultView): ResultEvidenceView | undefined {
  return [...view.evidence].reverse().find((item) => item.type === 'INTEGRITY');
}

function integrityState(view: ResultView): 'matched' | 'mismatch' | 'pending' {
  const artifact = latestArtifact(view);
  const evidence = integrityEvidence(view);
  if (artifact === undefined || evidence === undefined) return 'pending';
  return evidence.status === 'PASS' &&
    evidence.sourceHash === artifact.contentHash &&
    evidence.gitRevision === artifact.gitRevision &&
    artifact.gitRevision === view.task.expectedRevision
    ? 'matched'
    : 'mismatch';
}

function resultStateSummary(view: ResultView): string {
  const executionState = view.executions[0]?.state ?? 'NO_EXECUTION';
  if (view.verified) return `VERIFIED · ${view.projectState} · ${executionState}`;
  if (view.task.state === 'CLAIMED_COMPLETE') {
    return `UNVERIFIED · ${view.projectState} · ${executionState}`;
  }
  return `${executionState} · ${view.projectState} · ${view.task.state} · Not verified`;
}

function blockingReasons(view: ResultView): readonly string[] {
  const reasons: string[] = [...view.blockedReasons];
  const decision = latestVerificationDecision(view);
  if (decision?.outcome === 'STALE') reasons.push(decision.reason);
  if (view.task.state === 'CLAIMED_COMPLETE') reasons.push('Awaiting independent verification');
  for (const evidence of view.evidence) {
    if (evidence.status !== 'PASS') {
      reasons.push(`Required ${evidence.type} evidence did not pass`);
    }
    if (evidence.gitRevision !== view.task.expectedRevision) {
      reasons.push(`Required ${evidence.type} evidence is bound to another revision`);
    }
  }
  const artifact = latestArtifact(view);
  if (artifact !== undefined && artifact.gitRevision !== view.task.expectedRevision) {
    reasons.push('Published artifact is bound to another revision');
  }
  if (integrityState(view) === 'mismatch') {
    reasons.push('Artifact integrity evidence does not match the published content hash');
  }
  if (
    view.organizationLineage.reviewerAgentId !== null &&
    !view.organizationLineage.independentReview
  ) {
    reasons.push('Quality reviewer must be outside the author lineage');
  }
  if (view.task.state === 'VERIFYING' && reasons.length === 0) {
    reasons.push('Verification evaluation is pending');
  }
  if (view.projectState === 'PAUSED') reasons.push('Project is paused');
  if (view.projectState === 'STOPPING') reasons.push('Project is stopping');
  if (view.projectState === 'STOPPED') reasons.push('Project was stopped before verification');
  if (view.projectState === 'FAILED') reasons.push('Project failed before verification');
  if (view.projectState === 'CANCELLED') reasons.push('Project was cancelled');
  if (view.projectState === 'BLOCKED' && reasons.length === 0) {
    reasons.push('Project requires explicit remediation');
  }
  if (view.task.state === 'BLOCKED' && reasons.length === 0) {
    reasons.push('Verification policy did not pass');
  }
  return [...new Set(reasons)];
}

export function Results({ projectId }: { readonly projectId: string }) {
  const [view, setView] = useState<ResultView>();
  const [status, setStatus] = useState('Loading results…');

  const refresh = useCallback(async () => {
    setStatus('Loading results…');
    const next = await getResults(projectId);
    setView(next);
    setStatus('Results ready');
  }, [projectId]);

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : 'Unable to load project results.');
    });
  }, [refresh]);

  const blockers = useMemo(() => (view === undefined ? [] : blockingReasons(view)), [view]);
  const artifact = view === undefined ? undefined : latestArtifact(view);
  const integrity = view === undefined ? 'pending' : integrityState(view);

  return (
    <main>
      <h1>Results</h1>
      <p role="status" data-testid="results-status">
        {status}
      </p>
      <button onClick={() => void refresh()} disabled={status === 'Loading results…'}>
        Refresh results
      </button>

      {view !== undefined && (
        <section aria-labelledby="result-records-heading">
          <h2 id="result-records-heading">Result records</h2>

          <section aria-labelledby="result-summary-heading">
            <h3 id="result-summary-heading">Result summary</h3>
            <p data-testid="result-state-summary">{resultStateSummary(view)}</p>
            <p>
              Project control state: <strong>{label(view.projectState)}</strong>
            </p>
            <p>
              Task state:{' '}
              <strong data-testid="verification-state">{verificationState(view)}</strong>
            </p>
            <p data-testid="verified-flag">Verified: {view.verified ? 'Yes' : 'No'}</p>
            <p data-testid="recovery-summary">
              Recovery: {label(view.recovery.state)} · {view.recovery.progress}
            </p>
            <p>
              Task <code>{view.task.taskId}</code> · assignee{' '}
              <code>{view.task.assigneeAgentId ?? 'Unassigned'}</code>
            </p>
            <p>
              Expected revision: <code>{view.task.expectedRevision}</code>
            </p>
            <p data-testid="artifact-integrity">
              {integrity === 'matched'
                ? 'Integrity matched'
                : integrity === 'mismatch'
                  ? 'Integrity mismatch'
                  : 'Integrity pending'}
            </p>
            <div data-testid="reviewer-lineage">
              <p>
                Author agent <code>{view.organizationLineage.authorAgentId}</code> · lineage{' '}
                <code>{view.organizationLineage.authorLineageId}</code>
              </p>
              {view.organizationLineage.reviewerAgentId === null ? (
                <p>Reviewer not assigned</p>
              ) : (
                <>
                  <p>
                    Reviewer agent <code>{view.organizationLineage.reviewerAgentId}</code> · lineage{' '}
                    <code>{view.organizationLineage.reviewerLineageId}</code>
                  </p>
                  <p>
                    Independent review: {view.organizationLineage.independentReview ? 'Yes' : 'No'}
                  </p>
                </>
              )}
            </div>
            <div data-testid="blocking-reasons">
              <h4>Blocking reasons</h4>
              {blockers.length === 0 ? (
                <p>No blocking reasons</p>
              ) : (
                <ul>
                  {blockers.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section aria-labelledby="artifacts-heading">
            <h3 id="artifacts-heading">Artifacts</h3>
            {artifact === undefined ? (
              <p>No artifact published.</p>
            ) : (
              <table aria-label="Artifacts">
                <thead>
                  <tr>
                    <th scope="col">Artifact</th>
                    <th scope="col">Task / execution</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Content hash</th>
                    <th scope="col">Revision</th>
                    <th scope="col">Bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {view.artifacts.map((item) => (
                    <tr key={item.artifactId}>
                      <th scope="row">
                        <code>{item.artifactId}</code>
                      </th>
                      <td>
                        <code>{item.taskId}</code> / <code>{item.executionId}</code>
                      </td>
                      <td>{item.kind}</td>
                      <td>
                        <code>{item.contentHash}</code>
                      </td>
                      <td>
                        <code>{item.gitRevision}</code>
                      </td>
                      <td>{item.size}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="evidence-heading">
            <h3 id="evidence-heading">Evidence</h3>
            <table aria-label="Evidence matrix">
              <thead>
                <tr>
                  <th scope="col">Evidence</th>
                  <th scope="col">Rule / outcome</th>
                  <th scope="col">Artifact / execution</th>
                  <th scope="col">Producer</th>
                  <th scope="col">Revision</th>
                  <th scope="col">Source hash</th>
                </tr>
              </thead>
              <tbody>
                {view.evidence.map((item) => (
                  <tr key={item.evidenceId}>
                    <th scope="row">
                      <code>{item.evidenceId}</code>
                    </th>
                    <td>
                      {item.type} / {item.status}
                    </td>
                    <td>
                      <code>{item.artifactId ?? 'No artifact'}</code> /{' '}
                      <code>{item.executionId ?? 'No execution'}</code>
                    </td>
                    <td>
                      <code>{item.producerAgentId}</code>
                    </td>
                    <td>
                      <code>{item.gitRevision}</code>
                    </td>
                    <td>
                      <code>{item.sourceHash}</code>
                    </td>
                  </tr>
                ))}
                {view.evidence.length === 0 && (
                  <tr>
                    <td colSpan={6}>No evidence recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section aria-labelledby="approvals-heading">
            <h3 id="approvals-heading">Approval history</h3>
            {view.approvals.length === 0 ? (
              <p>No approvals recorded.</p>
            ) : (
              <ol>
                {view.approvals.map((approval) => (
                  <li key={approval.approvalId}>
                    <code>{approval.approvalId}</code> · task <code>{approval.taskId}</code> ·{' '}
                    requester <code>{approval.requesterAgentId}</code> · {label(approval.state)} ·{' '}
                    {approval.reason} · <code>{approval.actionDigest}</code>
                    {approval.decidedAt === null ? null : (
                      <>
                        {' '}
                        · decided <time dateTime={approval.decidedAt}>
                          {approval.decidedAt}
                        </time> by <code>{approval.decisionActorId}</code>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="executions-heading" data-testid="execution-provenance">
            <h3 id="executions-heading">Backend execution history</h3>
            {view.executions.map((execution) => (
              <article key={execution.executionId}>
                <h4>
                  Attempt {execution.attemptNumber}: {execution.state}
                </h4>
                <p>
                  Execution <code>{execution.executionId}</code> · task{' '}
                  <code>{execution.taskId}</code> · agent <code>{execution.agentId}</code> · runtime{' '}
                  <code>{execution.runtimeId}</code>
                </p>
                <p>
                  Connection <code>{execution.backendConnectionId}</code> · model descriptor{' '}
                  <code>{execution.modelDescriptorId}</code> v{execution.modelDescriptorVersion} ·
                  route decision <code>{execution.routeDecisionId}</code>
                </p>
                <p>
                  Started <time dateTime={execution.startedAt}>{execution.startedAt}</time>
                  {execution.endedAt === null ? null : (
                    <>
                      {' '}
                      · ended <time dateTime={execution.endedAt}>{execution.endedAt}</time>
                    </>
                  )}
                </p>
              </article>
            ))}
          </section>

          <section aria-labelledby="checkpoints-heading">
            <h3 id="checkpoints-heading">Checkpoint and effect history</h3>
            {view.checkpoints.length === 0 ? (
              <p>No checkpoint recorded.</p>
            ) : (
              <ol>
                {view.checkpoints.map((checkpoint) => (
                  <li key={checkpoint.checkpointId}>
                    <code>{checkpoint.checkpointId}</code> · {checkpoint.reason} · execution{' '}
                    <code>{checkpoint.executionId}</code> · task <code>{checkpoint.taskId}</code> ·
                    revision <code>{checkpoint.gitRevision}</code> · checkpoint{' '}
                    {checkpoint.schemaVersion} <code>{checkpoint.contentHash}</code> ·{' '}
                    <time dateTime={checkpoint.createdAt}>{checkpoint.createdAt}</time>
                  </li>
                ))}
              </ol>
            )}
            {view.effects.length === 0 ? (
              <p>No external effects recorded.</p>
            ) : (
              <ol>
                {view.effects.map((effect) => (
                  <li key={effect.effectId}>
                    Effect <code>{effect.effectId}</code> · task <code>{effect.taskId}</code> ·{' '}
                    {label(effect.state)} · <code>{effect.actionDigest}</code> · semantic key{' '}
                    <code>{effect.semanticKey}</code>
                    {effect.reconciliationOutcome === null
                      ? null
                      : ` · ${effect.reconciliationOutcome}`}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="audit-heading">
            <h3 id="audit-heading">Audit timeline</h3>
            <ol>
              {view.audit.map((item) => (
                <li
                  key={item.auditEventId}
                  data-sequence={item.sequence}
                  data-event-id={item.auditEventId}
                >
                  {item.sequence}. <code>{item.auditEventId}</code> · project event{' '}
                  <code>{item.projectEventId}</code>
                  {item.supervisionSequence === null
                    ? null
                    : ` · supervision sequence ${item.supervisionSequence}`}{' '}
                  · <time dateTime={item.occurredAt}>{item.occurredAt}</time> · {item.actorType}{' '}
                  <code>{item.actorId}</code> · {item.action} · {item.targetType}{' '}
                  <code>{item.targetId}</code> · task <code>{item.taskId}</code> · {item.reason} ·{' '}
                  {item.outcome} · correlation <code>{item.correlationId}</code>
                </li>
              ))}
            </ol>
          </section>
        </section>
      )}
    </main>
  );
}
