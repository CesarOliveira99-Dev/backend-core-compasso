import type { Appointment, Feedback } from '../../../core/domain/models.js';

export function verifiedReviews(reviews: Feedback[], appointments: Appointment[]) {
  const completed = new Map(
    appointments.filter((item) => item.status === 'completed').map((item) => [item.id, item]),
  );
  const seen = new Set<string>();
  return reviews.filter((review) => {
    const appointment = completed.get(review.appointmentId);
    if (
      !appointment ||
      appointment.customerId !== review.customerId ||
      seen.has(appointment.id) ||
      !Number.isInteger(review.rating) ||
      review.rating < 1 ||
      review.rating > 5
    )
      return false;
    seen.add(appointment.id);
    return true;
  });
}
export function reviewSummary(reviews: Feedback[]) {
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const review of reviews) distribution[review.rating]++;
  return {
    count: reviews.length,
    average: reviews.length
      ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length
      : 0,
    distribution,
  };
}
export interface RecommendationEntitlement {
  status: string;
  paid: boolean;
  paymentId: string;
  expiresAt: string;
}
export function recommendationStatus(
  summary: ReturnType<typeof reviewSummary>,
  entitlement?: RecommendationEntitlement,
  now = Date.now(),
) {
  const minimumRating = 4.8,
    minimumReviews = 10;
  const qualified = summary.count >= minimumReviews && summary.average >= minimumRating;
  const paidAddonActive =
    !!entitlement &&
    entitlement.status === 'active' &&
    entitlement.paid === true &&
    !!entitlement.paymentId &&
    Date.parse(entitlement.expiresAt) > now;
  return {
    active: qualified && paidAddonActive,
    qualified,
    paidAddonActive,
    minimumRating,
    minimumReviews,
  };
}
