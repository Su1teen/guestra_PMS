import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import ReservationWorkspace from '../reservations/ReservationWorkspace';
export interface GuestDetailsReservation {
  id: string;
  confirmationNumber: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  roomId?: string;
  roomNumber?: string;
  roomTypeId?: string;
  roomTypeName?: string;
  guestId?: string;
  guestName?: string;
  guest?: {
    firstName: string;
    lastName: string;
    vipLevel?: string;
    loyaltyNumber?: string | null;
    email?: string | null;
    phone?: string | null;
    nationality?: string | null;
  };
  bookingId?: string;
  ratePlanId?: string;
  totalAmount?: string;
  doNotMove?: boolean;
  balance?: number;
}

export default function GuestDetailsModal({ open, reservation, doorPin, onClose, onNotes, onMove, onCheckIn, onCheckOut }: {
  open: boolean; reservation: GuestDetailsReservation | null; propertyId: string; currencyCode: string | null; doorPin?: string | null;
  onClose: () => void; onNotes: (r: GuestDetailsReservation) => void; onMove: (r: GuestDetailsReservation) => void;
  onCheckIn: (r: GuestDetailsReservation) => void; onCheckOut?: (r: GuestDetailsReservation) => void;
  guestLabel: (r: GuestDetailsReservation) => string;
}) {
  const { t } = useTranslation(); const { hasPermission } = useAuth();
  if (!open || !reservation) return null;
  const action = (fn: (r: GuestDetailsReservation) => void) => { onClose(); fn(reservation); };
  return <ReservationWorkspace key={reservation.id} reservationId={reservation.id} initial={{ ...reservation,
    adults: 1, children: 0, guest: reservation.guest ? { ...reservation.guest, id: reservation.guestId ?? '' } : undefined,
  }} onClose={onClose} doorPin={doorPin} actions={hasPermission('reservations.write') && <>
    <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => action(onNotes)}>{t('frontDesk.notes')}</button>
    {['assigned','checked_in','stayover','due_out'].includes(reservation.status) && <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => action(onMove)}>{t('frontDesk.moveRoom')}</button>}
    {['confirmed','assigned'].includes(reservation.status) && <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => action(onCheckIn)}>{t('frontDesk.earlyCheckIn')}</button>}
    {['checked_in','stayover','due_out'].includes(reservation.status) && onCheckOut && <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => action(onCheckOut)}>{t('frontDesk.earlyCheckout')}</button>}
  </>}/>;
}
