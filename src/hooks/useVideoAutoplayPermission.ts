import { useEffect, useState } from "react";

export function useVideoAutoplayPermission() {
  const [hasPermission, setHasPermission] = useState(false);

  useEffect(() => {
    const handleInteraction = () => {
      setHasPermission(true);
      // Remove listeners once permission is granted
      document.removeEventListener("mousedown", handleInteraction);
      document.removeEventListener("click", handleInteraction);
      document.removeEventListener("touchstart", handleInteraction);
    };

    document.addEventListener("mousedown", handleInteraction);
    document.addEventListener("click", handleInteraction);
    document.addEventListener("touchstart", handleInteraction);

    return () => {
      document.removeEventListener("mousedown", handleInteraction);
      document.removeEventListener("click", handleInteraction);
      document.removeEventListener("touchstart", handleInteraction);
    };
  }, []);

  return hasPermission;
}
