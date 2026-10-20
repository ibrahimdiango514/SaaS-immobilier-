import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownRight, ArrowUpRight, Award, Building2, Download, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAllRevenueOperations, useAllAgencies } from '@/lib/data-hooks';
import type { RevenueOperationRow } from '@/lib/database.types';
import { AdminHeading } from './admin-shell';
import { ErrorState, LoadingRows, cash, downloadCsv, useSafeRetry } from '@/lib/workspace-ui';
import { CHART_COLORS, computeStats, periodRange, type PeriodKey } from '@/lib/revenue-utils';

type AgencyRowAgg = {
  agency_id: string;
  name: string;
  caTotal: number;
  caYear: number;
  caMonth: number;
  count: number;
  avg: number;
};

const adminPeriods: Array<{ key: PeriodKey; label: string }> = [
  { key: 'month', label: 'Mois en cours' },
  { key: 'm3', label: '3 mois' },
  { key: 'm6', label: '6 mois' },
  { key: 'm12', label: '12 mois' },
  { key: 'year', label: 'Année en cours' },
  { key: 'all', label: 'Tout' },
];

export default function AdminRevenuePage() {
  const operationsQ = useAllRevenueOperations();
  const agenciesQ = useAllAgencies();
  const [period, setPeriod] = useState<PeriodKey>('year');

  const operations = useMemo(() => operationsQ.data ?? [], [operationsQ.data]);
  const agencyName = (id: string) => agenciesQ.data?.agencies.find((agency) => agency.id === id)?.name ?? 'Agence inconnue';

  const range = useMemo(() => periodRange(period), [period]);
  const stats = useMemo(() => computeStats(operations, range), [operations, range]);
  const monthStats = useMemo(() => computeStats(operations, periodRange('month')), [operations]);
  const yearStats = useMemo(() => computeStats(operations, periodRange('year')), [operations]);

  const rows = useMemo<AgencyRowAgg[]>(() => {
    const map = new Map<string, AgencyRowAgg>();
    const push = (operation: RevenueOperationRow, field: 'caTotal' | 'caYear' | 'caMonth') => {
      if (operation.status !== 'completed') return;
      const existing = map.get(operation.agency_id) ?? {
        agency_id: operation.agency_id,
        name: agencyName(operation.agency_id),
        caTotal: 0,
        caYear: 0,
        caMonth: 0,
        count: 0,
        avg: 0,
      };
      existing[field] += Number(operation.amount || 0);
      map.set(operation.agency_id, existing);
    };
    for (const operation of operations) push(operation, 'caTotal');
    for (const operation of operations.filter((op) => new Date(`${op.operation_date}T12:00:00`) >= (periodRange('year').from ?? new Date(0)))) push(operation, 'caYear');
    for (const operation of operations.filter((op) => new Date(`${op.operation_date}T12:00:00`) >= (periodRange('month').from ?? new Date(0)))) push(operation, 'caMonth');
    const countMap = new Map<string, number>();
    for (const operation of operations) {
      if (operation.status !== 'completed') continue;
      countMap.set(operation.agency_id, (countMap.get(operation.agency_id) ?? 0) + 1);
    }
    for (const [agency_id, count] of countMap) {
      const entry = map.get(agency_id);
      if (entry) entry.count = count;
    }
    // Une ligne « 0 » pour chaque agence sans opération (classement complet).
    for (const agency of agenciesQ.data?.agencies ?? []) {
      if (!map.has(agency.id)) {
        map.set(agency.id, { agency_id: agency.id, name: agency.name, caTotal: 0, caYear: 0, caMonth: 0, count: 0, avg: 0 });
      }
    }
    const list = [...map.values()].map((entry) => ({ ...entry, avg: entry.count ? entry.caTotal / entry.count : 0 }));
    return list.sort((a, b) => b.caTotal - a.caTotal);
  }, [operations, agenciesQ.data]);

  const chartData = useMemo(
    () => rows.filter((row) => row.caTotal > 0).slice(0, 10).map((row) => ({ name: row.name.length > 16 ? `${row.name.slice(0, 16)}…` : row.name, ca: row.caTotal })),
    [rows],
  );

  const exportCsv = () => {
    downloadCsv(
      `sofia-ca-plateforme-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Rang', 'Agence', 'CA total', `CA ${new Date().getFullYear()}`, 'CA mois', 'Opérations', 'Panier moyen', 'Devise'],
      rows.map((row, index) => [
        index + 1,
        row.name,
        row.caTotal,
        row.caYear,
        row.caMonth,
        row.count,
        Math.round(row.avg),
        'XOF',
      ]),
    );
  };

  const loading = operationsQ.isLoading || agenciesQ.isLoading;
  const error = operationsQ.error ?? agenciesQ.error;

  return (
    <>
      <AdminHeading
        eyebrow="Pilotage financier"
        title="Chiffre d’affaires plateforme"
        description="Recette cumulée de toutes les agences, CA par agence et classement — calculs temps réel depuis les opérations enregistrées."
        action={
          <Button variant="outline" onClick={exportCsv} data-testid="button-export-admin-revenue">
            <Download size={14} /> Export CSV
          </Button>
        }
      />

      <section className="list-toolbar revenue-toolbar" aria-label="Filtre de période globale">
        <label className="revenue-period-select">
          <TrendingUp size={15} />
          <select className="form-select" value={period} onChange={(event) => setPeriod(event.target.value as PeriodKey)} aria-label="Période" data-testid="select-admin-revenue-period">
            {adminPeriods.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
          </select>
        </label>
        <span className="result-count">{stats.count} opération(s) effectuée(s)</span>
      </section>

      {loading ? (
        <LoadingRows label="Chargement du chiffre d’affaires" />
      ) : error ? (
        <ErrorState error={error} retry={useSafeRetry(error && operationsQ.error ? operationsQ : agenciesQ)} testId="status-admin-revenue-error" />
      ) : (
        <>
          <div className="kpi-grid kpi-grid-compact">
            <div className="kpi-card accent-teal" data-testid="kpi-admin-ca-total">
              <div className="kpi-top"><span>CA total plateforme</span><span className="kpi-icon"><TrendingUp size={14} /></span></div>
              <strong className="kpi-value">{cash(stats.ca, 'XOF')}</strong>
              <div className="kpi-foot">{period === 'all' ? 'Tout l’historique' : 'Période sélectionnée'}{stats.variation != null && <span className={`trend-chip ${stats.variation >= 0 ? 'is-up' : 'is-down'}`}>{stats.variation >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{Math.abs(stats.variation).toFixed(1)} %</span>}</div>
            </div>
            <div className="kpi-card accent-blue" data-testid="kpi-admin-ca-year">
              <div className="kpi-top"><span>CA {new Date().getFullYear()}</span><span className="kpi-icon"><Award size={14} /></span></div>
              <strong className="kpi-value">{cash(yearStats.ca, 'XOF')}</strong>
              <div className="kpi-foot">{yearStats.count} opération(s) cette année</div>
            </div>
            <div className="kpi-card accent-amber" data-testid="kpi-admin-ca-month">
              <div className="kpi-top"><span>CA du mois</span><span className="kpi-icon"><Building2 size={14} /></span></div>
              <strong className="kpi-value">{cash(monthStats.ca, 'XOF')}</strong>
              <div className="kpi-foot">Panier moyen {cash(monthStats.avg, 'XOF')}</div>
            </div>
            <div className="kpi-card accent-violet" data-testid="kpi-admin-agencies-ca">
              <div className="kpi-top"><span>Agences avec CA</span><span className="kpi-icon"><Award size={14} /></span></div>
              <strong className="kpi-value">{String(rows.filter((row) => row.caTotal > 0).length)}</strong>
              <div className="kpi-foot">sur {rows.length} agence(s)</div>
            </div>
          </div>

          <div className="admin-grid">
            <article className="panel chart-panel">
              <div className="panel-head">
                <div><h2>CA par agence</h2><p>Top 10 des agences par recette cumulée</p></div>
                <TrendingUp size={17} />
              </div>
              <div className="chart-box">
                {chartData.length ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={chartData} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(120,140,130,0.18)" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#7b8a82' }} />
                      <YAxis tick={{ fontSize: 11, fill: '#7b8a82' }} tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
                      <Tooltip formatter={(value) => [cash(Number(value), 'XOF'), 'CA']} cursor={{ fill: 'rgba(14,159,110,0.07)' }} />
                      <Bar dataKey="ca" radius={[6, 6, 0, 0]}>
                        {chartData.map((_, index) => (
                          <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="empty-table"><strong>Aucune opération enregistrée sur la plateforme</strong></div>
                )}
              </div>
            </article>

            <article className="panel">
              <div className="panel-head">
                <div><h2>Podium</h2><p>Classement des agences par CA total</p></div>
                <Award size={17} />
              </div>
              <ol className="ranking-list" data-testid="list-admin-revenue-ranking">
                {rows.slice(0, 5).map((row, index) => (
                  <li key={row.agency_id}>
                    <span className="rank-position">{index + 1}</span>
                    <span className="rank-copy"><strong>{row.name}</strong><small>{row.count} opération(s) · panier {cash(row.avg, 'XOF')}</small></span>
                    <span className="rank-value">{cash(row.caTotal, 'XOF')}</span>
                  </li>
                ))}
                {!rows.length && <li><span className="rank-copy"><strong>Aucune agence</strong></span></li>}
              </ol>
            </article>
          </div>

          <section className="panel list-panel">
            <div className="panel-head">
              <div><h2>CA par agence</h2><p>Classement complet — exportable en CSV</p></div>
              <Building2 size={17} />
            </div>
            <div className="table-wrap">
              <table className="data-table full-table">
                <thead>
                  <tr><th>#</th><th>Agence</th><th>CA total</th><th>CA année</th><th>CA mois</th><th>Opérations</th><th>Panier moyen</th></tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.agency_id} data-testid={`row-admin-revenue-${row.agency_id}`}>
                      <td><span className="rank-position">{index + 1}</span></td>
                      <td><strong>{row.name}</strong></td>
                      <td>{cash(row.caTotal, 'XOF')}</td>
                      <td>{cash(row.caYear, 'XOF')}</td>
                      <td>{cash(row.caMonth, 'XOF')}</td>
                      <td>{row.count}</td>
                      <td>{cash(row.avg, 'XOF')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && <div className="empty-table"><strong>Aucune donnée de CA</strong></div>}
          </section>
        </>
      )}
    </>
  );
}
