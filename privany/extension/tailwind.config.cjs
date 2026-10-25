/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#14213D", soft: "#2B3A5C", faint: "#5A6782" },
        paper: { DEFAULT: "#EEF1F6", deep: "#E1E6EF" },
        marker: "#FFE45C",
        miss: "#D7263D",
        kept: "#1B998B",
        unsure: "#8D99AE",
        amber: "#E9902B",
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        quote: ["Charter", "Bitstream Charter", "Iowan Old Style", "Sitka Text", "Georgia", "serif"],
      },
      fontSize: {
        // modular scale (1.2), small UI sizes
        xs2: ["11px", "15px"], xs: ["12px", "17px"], sm: ["13.5px", "19px"], base: ["15px", "22px"],
        lg: ["18px", "24px"], xl: ["21.5px", "27px"], "2xl": ["26px", "30px"], glyph: ["40px", "40px"],
      },
      keyframes: {
        drain: { from: { transform: "scaleX(1)" }, to: { transform: "scaleX(0)" } },
        rise: { from: { transform: "translateY(12px)", opacity: "0" }, to: { transform: "none", opacity: "1" } },
      },
      animation: { rise: "rise 260ms cubic-bezier(.2,.8,.2,1)" },
    },
  },
  plugins: [],
};
