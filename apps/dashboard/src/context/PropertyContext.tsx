import { createContext, useContext, useState, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';
import { api, setPropertyId as setApiPropertyId } from '../lib/api';
import { errorMessage } from '../lib/error-message';
import { joinPropertyRoom, leavePropertyRoom } from '../lib/socket';
import { logRuntimeFailure } from '../lib/runtime-errors';
import {
  PORTFOLIO_MODE_ID,
  type PropertySummary,
  type OrganizationSummary,
} from '../lib/property-types';

interface PropertyContextValue {
  propertyId: string | null;
  /** null when unknown — portfolio mode, or a property with no code. Never a
   *  substituted default: see lib/money.ts. */
  currencyCode: string | null;
  setPropertyId: (id: string) => void;
  isPortfolioMode: boolean;
  properties: PropertySummary[];
  organizations: OrganizationSummary[];
  propertiesLoading: boolean;
  propertiesError: string | null;
}

const PropertyContext = createContext<PropertyContextValue>({
  propertyId: null,
  currencyCode: null,
  setPropertyId: () => {},
  isPortfolioMode: false,
  properties: [],
  organizations: [],
  propertiesLoading: false,
  propertiesError: null,
});

export function PropertyProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [defaultPropertyId, setPropertyIdState] = useState<string | null>(null);
  // URL scope is authoritative for direct links and browser Back/Forward.
  const propertyId = searchParams.get('propertyId') ?? defaultPropertyId;
  const latestPropertyId = useRef(propertyId);
  latestPropertyId.current = propertyId;
  const [properties, setProperties] = useState<PropertySummary[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [propertiesLoading, setPropertiesLoading] = useState(true);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);

  const isPortfolioMode = propertyId === PORTFOLIO_MODE_ID;
  // Portfolio mode spans properties that may not share a currency, so it has no
  // single answer — and NULL is that answer. Substituting one property's code,
  // or a house default, prints a currency nobody chose next to real money.
  // formatMoney renders an unsymbolled number when the code is null, which is
  // the honest rendering of "we do not know".
  const currencyCode =
    (!isPortfolioMode &&
      properties.find((p) => p.id === propertyId)?.currencyCode) ||
    null;

  function setPropertyId(id: string) {
    setApiPropertyId(id === PORTFOLIO_MODE_ID ? null : id);
    setPropertyIdState(id);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('propertyId', id);
      return next;
    });
  }

  useEffect(() => {
    const controller = new AbortController();
    setPropertiesLoading(true);
    setPropertiesError(null);
    Promise.all([
      api.get('/v1/properties', { signal: controller.signal }),
      api.get('/v1/organizations', { skipErrorToast: true, signal: controller.signal }).catch((err) => {
        if (!axios.isCancel(err)) logRuntimeFailure('request', err);
        return { data: [] };
      }),
    ])
      .then(([propRes, orgRes]) => {
        if (controller.signal.aborted) return;
        const list: PropertySummary[] = propRes.data?.data ?? propRes.data ?? [];
        const orgList: OrganizationSummary[] = orgRes.data?.data ?? orgRes.data ?? [];
        if (!Array.isArray(list) || !Array.isArray(orgList)) throw new Error('Invalid property bootstrap response');
        setProperties(list);
        setOrganizations(orgList);
        if (!latestPropertyId.current && list.length > 0) {
          // Default to portfolio when user has multiple properties
          setPropertyId(list.length > 1 ? PORTFOLIO_MODE_ID : list[0].id);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) setPropertiesError(errorMessage(err));
      })
      .finally(() => { if (!controller.signal.aborted) setPropertiesLoading(false); });
    return () => controller.abort();
    // Bootstrap once; propertyId auto-select handled inside the effect.
  }, []);

  useLayoutEffect(() => {
    setApiPropertyId(isPortfolioMode ? null : propertyId);
  }, [propertyId, isPortfolioMode]);

  useEffect(() => {
    if (propertyId && !isPortfolioMode) {
      joinPropertyRoom(propertyId);
      return () => leavePropertyRoom(propertyId);
    }
  }, [propertyId, isPortfolioMode]);

  return (
    <PropertyContext.Provider
      value={{
        propertyId,
        currencyCode,
        setPropertyId,
        isPortfolioMode,
        properties,
        organizations,
        propertiesLoading,
        propertiesError,
      }}
    >
      {children}
    </PropertyContext.Provider>
  );
}

export function useProperty() {
  return useContext(PropertyContext);
}

export { PORTFOLIO_MODE_ID };
