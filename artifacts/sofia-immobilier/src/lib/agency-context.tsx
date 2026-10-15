import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AgencyMemberRow, AgencyRow } from './database.types';
import { useAgencyMemberships, useAgencies } from './data-hooks';
import { useAuth } from './auth-context';

interface AgencyContextValue {
  memberships: AgencyMemberRow[];
  agencies: AgencyRow[];
  activeAgency: AgencyRow | null;
  activeMembership: AgencyMemberRow | null;
  activeAgencyId: string | undefined;
  canManageAgency: boolean;
  loading: boolean;
  error: Error | null;
  setActiveAgencyId: (agencyId: string) => void;
}

const AgencyContext = createContext<AgencyContextValue | null>(null);

export function AgencyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const membershipsQuery = useAgencyMemberships(user?.id);
  const memberships = membershipsQuery.data ?? [];
  const membershipAgencyIds = useMemo(
    () => [...new Set(memberships.map((membership) => membership.agency_id))],
    [memberships],
  );
  const agenciesQuery = useAgencies(membershipAgencyIds);
  const agencies = agenciesQuery.data ?? [];
  const [selectedAgencyId, setSelectedAgencyId] = useState<string | undefined>();

  useEffect(() => {
    if (!user) {
      setSelectedAgencyId(undefined);
      return;
    }
    if (!membershipsQuery.isSuccess) return;

    const remembered = window.localStorage.getItem(`sofia-agency:${user.id}`);
    const allowed = new Set(membershipAgencyIds);
    setSelectedAgencyId((current) => {
      if (current && allowed.has(current)) return current;
      if (remembered && allowed.has(remembered)) return remembered;
      return membershipAgencyIds[0];
    });
  }, [user?.id, membershipsQuery.isSuccess, membershipAgencyIds, user]);

  const setActiveAgencyId = (agencyId: string) => {
    if (!membershipAgencyIds.includes(agencyId)) return;
    setSelectedAgencyId(agencyId);
    if (user) window.localStorage.setItem(`sofia-agency:${user.id}`, agencyId);
  };

  const activeAgencyId =
    selectedAgencyId && membershipAgencyIds.includes(selectedAgencyId)
      ? selectedAgencyId
      : undefined;
  const activeAgency = agencies.find((agency) => agency.id === activeAgencyId) ?? null;
  const activeMembership =
    memberships.find(
      (membership) => membership.agency_id === activeAgencyId && membership.status === 'active',
    ) ?? null;
  const error =
    membershipsQuery.error ??
    agenciesQuery.error ??
    (membershipAgencyIds.length > 0 && agenciesQuery.isSuccess && agencies.length !== membershipAgencyIds.length
      ? new Error('Une ou plusieurs agences associées au compte ne sont pas accessibles.')
      : null);

  const value: AgencyContextValue = {
    memberships,
    agencies,
    activeAgency,
    activeMembership,
    activeAgencyId,
    canManageAgency: activeMembership?.role === 'owner' || activeMembership?.role === 'admin',
    loading: membershipsQuery.isLoading || (membershipAgencyIds.length > 0 && agenciesQuery.isLoading),
    error: error as Error | null,
    setActiveAgencyId,
  };

  return <AgencyContext.Provider value={value}>{children}</AgencyContext.Provider>;
}

export function useAgency(): AgencyContextValue {
  const context = useContext(AgencyContext);
  if (!context) throw new Error('useAgency doit être utilisé dans AgencyProvider.');
  return context;
}
