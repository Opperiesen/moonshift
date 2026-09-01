import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  controlProject,
  decideApproval,
  getProject,
  listApprovals,
  type ProjectView,
  type SupervisionView,
} from '../../services/project-api.js';

const label = (value: string) =>
  value
    .replaceAll('_', ' ')
    .toLocaleLowerCase('en-US')
    .replace(/^./u, (character) => character.toLocaleUpperCase('en-US'));

function projectStateLabel(state: string): string {
  if (state === 'STOPPED') return 'Stopped · resumable';
  if (state === 'CANCELLED') return 'Cancelled · terminal';
  return label(state);
}

export function Supervise({
  initial,
  onProjectChange,
}: {
  readonly initial: ProjectView;
  readonly onProjectChange: (project: ProjectView) => void;
}) {
  const [project, setProject] = useState(initial);
  const [view, setView] = useState<SupervisionView>();
  const [decisionReason, setDecisionReason] = useState('');
  const [controlReason, setControlReason] = useState('');
  const [status, setStatus] = useState('Loading supervision…');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const fresh = await listApprovals(initial.projectId);
    setView(fresh);
    return fresh;
  }, [initial.projectId]);

  useEffect(() => {
    void refresh()
      .then(() => setStatus('Supervision ready'))
      .catch((error: unknown) =>
        setStatus(error instanceof Error ? error.message : 'Unable to load supervision.'),
      );
  }, [refresh]);

  const approval = view?.items.at(-1);
  const effect = useMemo(
    () => view?.effects.filter((item) => item.actionDigest === approval?.actionDigest).at(-1),
    [approval?.actionDigest, view?.effects],
  );
  const projectState = view?.projectState ?? project.status;
  const approvalState =
    approval?.state === 'REQUESTED' && projectState === 'PAUSED'
      ? 'Requested · unavailable while paused'
      : approval === undefined
        ? 'None'
        : label(approval.state);
  const effectState =
    effect?.state === 'APPLIED'
      ? 'Applied'
      : effect?.state === 'EXECUTING'
        ? 'Executing'
        : effect?.state === 'UNKNOWN'
          ? 'Unknown · reconciliation required'
          : effect?.state === 'RECONCILING'
            ? 'Reconciling'
            : effect?.state === 'RECONCILED'
              ? effect.reconciliationOutcome === 'GROUND_TRUTH_APPLIED'
                ? 'Reconciled · applied'
                : 'Reconciled · not applied'
              : effect?.state === 'REQUESTED'
                ? 'Not applied · awaiting approval'
                : 'Not applied';
  const remaining = Math.max(
    0,
    (view?.budget.invocationLimit ?? 0) - (view?.budget.consumedInvocations ?? 0),
  );
  const canDecide = approval?.state === 'REQUESTED' && projectState === 'ACTIVE' && !busy;

  async function decide(decision: 'APPROVE' | 'REJECT'): Promise<void> {
    if (approval === undefined) return;
    setBusy(true);
    setStatus('Recording decision…');
    try {
      await decideApproval({
        projectId: project.projectId,
        approvalId: approval.approvalId,
        decision,
        actionDigest: approval.actionDigest,
        reason: decisionReason,
      });
      const [freshView, freshProject] = await Promise.all([
        refresh(),
        getProject(project.projectId),
      ]);
      setView(freshView);
      setProject(freshProject);
      onProjectChange(freshProject);
      setStatus(decision === 'APPROVE' ? 'Approval recorded' : 'Rejection recorded');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to record the decision.');
    } finally {
      setBusy(false);
    }
  }

  async function control(command: 'pause' | 'resume' | 'stop' | 'cancel'): Promise<void> {
    if (view === undefined) return;
    setBusy(true);
    setStatus(`${label(command)} requested…`);
    try {
      await controlProject({
        projectId: project.projectId,
        command,
        reason: controlReason,
        projectVersion: view.projectVersion,
      });
      const [freshView, freshProject] = await Promise.all([
        refresh(),
        getProject(project.projectId),
      ]);
      setView(freshView);
      setProject(freshProject);
      onProjectChange(freshProject);
      setStatus(`${label(command)} completed`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Unable to ${command} the project.`);
    } finally {
      setBusy(false);
    }
  }

  const authorityState =
    view?.authority.capabilityLeaseState === 'REVOKED' ||
    view?.authority.runnerLeaseState === 'REVOKED'
      ? 'Execution authority revoked'
      : view?.authority.successor
        ? 'Active with fresh successor authority'
        : 'Active fixture authority';

  return (
    <main>
      <h1>Supervise</h1>
      <p role="status">{status}</p>
      <button
        onClick={() =>
          void refresh()
            .then(() => setStatus('Supervision refreshed'))
            .catch((error: unknown) =>
              setStatus(error instanceof Error ? error.message : 'Unable to refresh supervision.'),
            )
        }
        disabled={busy}
      >
        Refresh supervision
      </button>

      <section aria-labelledby="approval-heading">
        <h2 id="approval-heading">Pending action</h2>
        {approval === undefined ? (
          <p>No approval request is available.</p>
        ) : (
          <>
            <p data-testid="approval-state">{approvalState}</p>
            <p>
              <strong>Scope:</strong> {approval.scope}
            </p>
            <p data-testid="approval-digest">
              <strong>Immutable action digest:</strong> {approval.actionDigest}
            </p>
            <p>
              <strong>Requester:</strong> {approval.requesterAgentId}
            </p>
            <p>
              <strong>Reason:</strong> {approval.reason}
            </p>
            <p>
              <strong>Risk:</strong> {approval.riskSummary}
            </p>
            <label>
              Decision reason
              <textarea
                value={decisionReason}
                maxLength={1_000}
                onChange={(event) => setDecisionReason(event.target.value)}
              />
            </label>
            <div>
              <button
                onClick={() => void decide('APPROVE')}
                disabled={!canDecide || decisionReason.trim().length === 0}
              >
                Approve action
              </button>{' '}
              <button
                onClick={() => void decide('REJECT')}
                disabled={!canDecide || decisionReason.trim().length === 0}
              >
                Reject action
              </button>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="resources-heading">
        <h2 id="resources-heading">Capacity and budget</h2>
        <p>
          Cognitive capacity: {project.capacity.activeCognitiveRuns}/
          {project.capacity.cognitiveRunLimit}
        </p>
        <p>
          Runner capacity: {project.capacity.activeRunnerJobs}/{project.capacity.runnerJobLimit}
        </p>
        <p data-testid="supervision-budget">
          {remaining} {remaining === 1 ? 'invocation' : 'invocations'} remaining ·{' '}
          {view?.budget.consumedMonetaryMicros ?? 0}/{view?.budget.monetaryLimitMicros ?? 0}{' '}
          monetary micros consumed
        </p>
        <p>
          Effect: <span data-testid="effect-state">{effectState}</span>
        </p>
        <p data-testid="blocked-reasons">
          {view?.blockedReasons.length ? view.blockedReasons.join(' · ') : 'No blocked reasons'}
        </p>
      </section>

      <section aria-labelledby="controls-heading">
        <h2 id="controls-heading">Project controls</h2>
        <p>
          State: <span data-testid="project-control-state">{projectStateLabel(projectState)}</span>
        </p>
        <p data-testid="authority-state">{authorityState}</p>
        <label>
          Control reason
          <textarea
            value={controlReason}
            maxLength={1_000}
            onChange={(event) => setControlReason(event.target.value)}
          />
        </label>
        <div>
          <button
            onClick={() => void control('pause')}
            disabled={
              busy || !['ACTIVE', 'BLOCKED'].includes(projectState) || !controlReason.trim()
            }
          >
            Pause project
          </button>{' '}
          <button
            onClick={() => void control('resume')}
            disabled={
              busy || !['PAUSED', 'STOPPED'].includes(projectState) || !controlReason.trim()
            }
          >
            Resume project
          </button>{' '}
          <button
            onClick={() => void control('stop')}
            disabled={
              busy ||
              !['ACTIVE', 'PAUSING', 'PAUSED', 'RESUMING', 'BLOCKED'].includes(projectState) ||
              !controlReason.trim()
            }
          >
            Stop project
          </button>{' '}
          <button
            onClick={() => void control('cancel')}
            disabled={busy || projectState === 'CANCELLED' || !controlReason.trim()}
          >
            Cancel project
          </button>
        </div>
      </section>
    </main>
  );
}
