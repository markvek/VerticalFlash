export function tiktokUploadState(status: string) {
  const processing = status !== "SEND_TO_USER_INBOX" && status !== "PUBLISH_COMPLETE";
  return {
    success: !processing,
    processing,
    httpStatus: processing ? 202 : 200,
    message: processing ? "TikTok is still processing. Check your TikTok inbox shortly." : "Sent to your TikTok inbox.",
  };
}
