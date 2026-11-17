// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ZoomableImage } from "@/components/zoomable-image";

describe("<ZoomableImage>", () => {
  it("renders the thumbnail and opens an uncropped lightbox on click", async () => {
    const user = userEvent.setup();
    render(
      <ZoomableImage
        src="http://files/s1/capture/shot.png"
        alt="Source asset"
        caption="capture/shot.png"
        className="object-contain"
      />,
    );

    // Thumbnail only, no dialog yet.
    expect(screen.getByAltText("Source asset")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enlarge capture/shot.png" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // The enlarged copy renders uncropped (object-contain) with its caption.
    const images = screen.getAllByAltText("Source asset");
    expect(images.length).toBe(2);
    expect(images.some((img) => img.className.includes("max-h-[85vh]"))).toBe(true);
    expect(screen.getAllByText("capture/shot.png").length).toBeGreaterThanOrEqual(1);
  });

  it("closes via the dialog close button", async () => {
    const user = userEvent.setup();
    render(<ZoomableImage src="http://files/s1/logo.svg" alt="Brand logo" />);
    await user.click(screen.getByRole("button", { name: "Enlarge Brand logo" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
