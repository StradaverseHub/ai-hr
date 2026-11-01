/** M08 — one task and its confirmed decision (mobile/lib/approval-decision.tsx). */
import {PackWorkspaceScreen} from '../../../lib/pack-workspace';
import {isPackWorkspaceKind} from '../../../../lib/mobile-api/v2/pack-workspaces';
import { useLocalSearchParams } from 'expo-router';
import { RequestWorkspaceScreen } from '../../../lib/request-workspace';
import { isRequestWorkspaceKind,validRequestReference } from '../../../../lib/mobile-api/v2/request-workspaces';
import { ReviewWorkspaceScreen } from '../../../lib/review-workspace';
import { isReviewWorkspaceKind } from '../../../../lib/mobile-api/v2/review-workspaces';
import { identityNamespace } from '../../../lib/config';
import { useSession } from '../../../lib/session';
import { authGeneration } from '../../../lib/auth';
import { ApprovalDetailScreen } from '../../../lib/approval-decision';
export default function ApprovalDetailPage() {
  const { employmentId } = useSession();
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  if(typeof kind==='string'&&isPackWorkspaceKind(kind)&&typeof id==='string'&&/^[0-9a-f-]{36}$/i.test(id))return <PackWorkspaceScreen key={`${identityNamespace()}:${authGeneration()}:${employmentId}:${kind}:${id}`} kind={kind} id={id}/>;
  if (typeof kind === 'string' && isRequestWorkspaceKind(kind) && typeof id === 'string' && validRequestReference(kind,id)) return <RequestWorkspaceScreen key={`${identityNamespace()}:${authGeneration()}:${employmentId}:${kind}:${id}`} kind={kind} id={id}/>;
  if (typeof kind === 'string' && isReviewWorkspaceKind(kind) && typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) return <ReviewWorkspaceScreen key={`${identityNamespace()}:${authGeneration()}:${employmentId}:${kind}:${id}`} kind={kind} id={id}/>;
  return <ApprovalDetailScreen key={`${identityNamespace()}:${authGeneration()}:${employmentId}:${kind}:${id}`} kind={typeof kind === 'string' ? kind : ''} id={typeof id === 'string' ? id : ''} />;
}
