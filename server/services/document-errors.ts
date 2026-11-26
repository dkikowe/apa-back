export const readingInterrupted = "Құжатты оқу аяқталмады.";
export const documentUnreadable = "Құжат оқылмады.";

// Earlier worker versions stored extra instructions after the status.
// Normalize only those historical messages when returning a saved document.
export function documentErrorMessage(error: string | null | undefined) {
  if (error?.startsWith(readingInterrupted + " Қолмен "))
    return readingInterrupted;
  if (error?.startsWith(documentUnreadable + " Мәліметтерді қолмен "))
    return documentUnreadable;
  return error;
}
