import axios from "axios";

export const sendEmail = async (
   to: string,
   message: string,
   from: string,
   subject: string
) => {
   try {
      const res = await axios.post(
         "https://api.emailjs.com/api/v1.0/email/send",
         {
            service_id: "service_ftkdtyh",
            template_id: "template_q5i7tdd",
            user_id: "5UbKWrsf15dIH544Z",
            template_params: {
               message,
               from,
               to,
               subject,
            },
         },
         {
            headers: {
               "Content-Type": "application/json",
               "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36", // Mimic browser user agent
               "Origin": "https://www.brainhealthanalytics.com", // Mimic browser origin
               "Referer": "https://www.brainhealthanalytics.com", // Mimic browser referer
            },
         }
      );

      return res.data;
   } catch (err) {
      console.log(err);
      return err;
   }
};
